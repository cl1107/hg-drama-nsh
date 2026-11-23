use crate::{
    ServiceError, media,
    server::{playback_input, random_token},
};
use axum::body::Bytes;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap},
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
pub(crate) struct Downloads(Arc<Store>);

struct Store {
    directory: PathBuf,
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    tasks: BTreeMap<String, Task>,
    running: HashMap<String, CancellationToken>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Task {
    id: String,
    series_id: String,
    episode_id: String,
    title: String,
    episode_index: u32,
    quality: String,
    codec: String,
    status: Status,
    bytes: u64,
    created_at: u64,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    file_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Status {
    Downloading,
    Completed,
    Failed,
    Cancelled,
}

impl Task {
    fn public_value(&self) -> Value {
        let mut public = json!(self);
        public
            .as_object_mut()
            .expect("download task object")
            .remove("filePath");
        public
    }
}

impl Downloads {
    pub(crate) fn open() -> io::Result<Self> {
        let directory = std::env::var_os("HG_NSH_DOWNLOAD_DIR")
            .map(PathBuf::from)
            .or_else(|| {
                directories::BaseDirs::new()
                    .map(|dirs| dirs.data_local_dir().join("com.hgdrama.nsh/downloads"))
            })
            .ok_or_else(|| io::Error::other("无法定位下载目录"))?;
        Self::open_at(directory)
    }

    fn open_at(directory: PathBuf) -> io::Result<Self> {
        let mut state = State::default();
        match fs::read(directory.join("tasks.json")) {
            Ok(contents) => {
                for mut task in serde_json::from_slice::<Vec<Task>>(&contents)? {
                    if task.status == Status::Downloading {
                        task.status = Status::Failed;
                        task.error = Some("服务重启中断，可点击重试".into());
                    } else if task.status == Status::Completed
                        && !valid_file(&directory, &task.file_path).is_some_and(Path::is_file)
                    {
                        task.status = Status::Failed;
                        task.error = Some("离线文件已丢失".into());
                    }
                    state.tasks.insert(task.id.clone(), task);
                }
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        Ok(Self(Arc::new(Store {
            directory,
            state: Mutex::new(state),
        })))
    }

    pub(crate) fn list(&self) -> Value {
        let state = self.0.state.lock().expect("downloads lock");
        let mut tasks: Vec<_> = state.tasks.values().collect();
        tasks.sort_by_key(|task| std::cmp::Reverse(task.created_at));
        json!({"items": tasks.into_iter().map(Task::public_value).collect::<Vec<_>>()})
    }

    pub(crate) fn change(&self, operation: &str, input: &Value) -> Result<Value, ServiceError> {
        let mut state = self.0.state.lock().expect("downloads lock");
        if operation == "/downloads/start" {
            let (series, episode, quality) = playback_input(input)?;
            let task = Task {
                id: random_token::<12>(),
                series_id: series.into(),
                episode_id: episode.unwrap_or("").into(),
                title: "正在获取剧集信息…".into(),
                episode_index: 1,
                quality: quality.into(),
                codec: String::new(),
                status: Status::Downloading,
                bytes: 0,
                created_at: SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map_err(storage_error)?
                    .as_millis() as u64,
                file_path: String::new(),
                error: None,
            };
            let response = task.public_value();
            self.0.update(&mut state, task.clone())?;
            self.start(&mut state, task);
            return Ok(response);
        }
        if operation == "/downloads/clear" {
            let scope = input["scope"].as_str().unwrap_or("finished");
            let ids: Vec<_> = state
                .tasks
                .values()
                .filter(|task| match scope {
                    "all" => task.status != Status::Downloading,
                    "completed" => task.status == Status::Completed,
                    _ => matches!(task.status, Status::Failed | Status::Cancelled),
                })
                .map(|task| task.id.clone())
                .collect();
            for id in &ids {
                self.0.delete(&mut state, id)?;
            }
            return Ok(json!({"cleared": ids.len()}));
        }

        let id = input["id"].as_str().ok_or_else(task_not_found)?;
        let mut task = state.tasks.get(id).cloned().ok_or_else(task_not_found)?;
        match operation {
            "/downloads/retry" if matches!(task.status, Status::Failed | Status::Cancelled) => {
                task.status = Status::Downloading;
                task.bytes = 0;
                task.error = None;
                self.0.update(&mut state, task.clone())?;
                self.start(&mut state, task.clone());
            }
            "/downloads/retry" => {}
            "/downloads/cancel" if task.status == Status::Downloading => {
                task.status = Status::Cancelled;
                task.error = Some("已取消下载".into());
                self.0.update(&mut state, task.clone())?;
                if let Some(cancel) = state.running.remove(id) {
                    cancel.cancel();
                }
            }
            "/downloads/cancel" => {}
            "/downloads/delete" => {
                self.0.delete(&mut state, id)?;
                return Ok(json!({"deleted": id}));
            }
            _ => return Err(task_not_found()),
        }
        Ok(task.public_value())
    }

    pub(crate) async fn play(&self, input: &Value) -> Result<(Bytes, Value), ServiceError> {
        let task = self
            .0
            .state
            .lock()
            .expect("downloads lock")
            .tasks
            .get(input["id"].as_str().unwrap_or(""))
            .filter(|task| task.status == Status::Completed)
            .cloned()
            .ok_or_else(|| ServiceError::new("NOT_FOUND", "离线媒体不可用"))?;
        let file = valid_file(&self.0.directory, &task.file_path)
            .ok_or_else(|| ServiceError::new("NOT_FOUND", "离线媒体不可用"))?;
        let data = tokio::fs::read(file).await.map_err(storage_error)?;
        let episode = json!({"episodeId": task.episode_id, "index": task.episode_index});
        Ok((
            data.into(),
            json!({
                "seriesId": task.series_id,
                "title": task.title,
                "episode": episode,
                "episodes": [episode],
                "codec": task.codec,
                "quality": task.quality,
                "encrypted": false,
            }),
        ))
    }

    fn start(&self, state: &mut State, mut task: Task) {
        let cancel = CancellationToken::new();
        state.running.insert(task.id.clone(), cancel.clone());
        let store = Arc::clone(&self.0);
        tokio::spawn(async move {
            let result = tokio::select! {
                _ = cancel.cancelled() => return,
                result = media::prepare(
                    &task.series_id,
                    (!task.episode_id.is_empty()).then_some(task.episode_id.as_str()),
                    &task.quality,
                ) => result,
            };
            let task_id = task.id.clone();
            let _ = tokio::task::spawn_blocking(move || {
                let mut state = store.state.lock().expect("downloads lock");
                if cancel.is_cancelled() {
                    return;
                }
                let outcome = result.and_then(|prepared| store.save(&mut task, prepared));
                if let Err(error) = outcome {
                    task.status = Status::Failed;
                    task.error = Some(error.to_string());
                }
                if let Err(error) = store.update(&mut state, task.clone()) {
                    if let Some(path) = valid_file(&store.directory, &task.file_path) {
                        let _ = fs::remove_file(path);
                    }
                    if let Some(current) = state.tasks.get_mut(&task_id) {
                        current.status = Status::Failed;
                        current.error = Some(error.to_string());
                    }
                }
                state.running.remove(&task_id);
            })
            .await;
        });
    }
}

impl Store {
    fn persist(&self, tasks: &BTreeMap<String, Task>) -> Result<(), ServiceError> {
        fs::create_dir_all(&self.directory).map_err(storage_error)?;
        let mut temp = tempfile::NamedTempFile::new_in(&self.directory).map_err(storage_error)?;
        let tasks: Vec<_> = tasks.values().collect();
        serde_json::to_writer(temp.as_file_mut(), &tasks).map_err(storage_error)?;
        temp.persist(self.directory.join("tasks.json"))
            .map_err(storage_error)?;
        Ok(())
    }

    fn update(&self, state: &mut State, task: Task) -> Result<(), ServiceError> {
        let id = task.id.clone();
        let previous = state.tasks.insert(id.clone(), task);
        if let Err(error) = self.persist(&state.tasks) {
            state.tasks.remove(&id);
            if let Some(previous) = previous {
                state.tasks.insert(id, previous);
            }
            return Err(error);
        }
        Ok(())
    }

    fn delete(&self, state: &mut State, id: &str) -> Result<(), ServiceError> {
        let task = state.tasks.get(id).ok_or_else(task_not_found)?;
        if let Some(file) = valid_file(&self.directory, &task.file_path) {
            match fs::remove_file(file) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(storage_error(error)),
            }
        }
        let removed = state.tasks.remove(id).expect("download task exists");
        if let Err(error) = self.persist(&state.tasks) {
            state.tasks.insert(id.into(), removed);
            return Err(error);
        }
        if let Some(cancel) = state.running.remove(id) {
            cancel.cancel();
        }
        Ok(())
    }

    fn save(&self, task: &mut Task, prepared: media::Prepared) -> Result<(), ServiceError> {
        let meta = &prepared.metadata;
        let required = |value: &Value| {
            value
                .as_str()
                .map(str::to_owned)
                .ok_or_else(|| ServiceError::new("SERVICE_ERROR", "离线媒体信息不完整"))
        };
        task.episode_id =
            crate::server::identifier(&meta["episode"]["episodeId"], "分集编号无效")?.into();
        task.episode_index = meta["episode"]["index"]
            .as_u64()
            .and_then(|index| u32::try_from(index).ok())
            .ok_or_else(|| ServiceError::new("SERVICE_ERROR", "离线媒体集数无效"))?;
        task.title = required(&meta["title"])?;
        task.quality = required(&meta["quality"])?;
        task.codec = required(&meta["codec"])?;
        let target = self.directory.join(format!(
            "{}-{}-{}.mp4",
            task.series_id, task.episode_id, task.id
        ));
        let mut temp = tempfile::NamedTempFile::new_in(&self.directory).map_err(storage_error)?;
        temp.write_all(&prepared.data).map_err(storage_error)?;
        temp.persist(&target).map_err(storage_error)?;
        task.bytes = prepared.data.len() as u64;
        task.file_path = target.to_string_lossy().into_owned();
        task.status = Status::Completed;
        task.error = None;
        Ok(())
    }
}

fn valid_file<'a>(directory: &Path, value: &'a str) -> Option<&'a Path> {
    let path = Path::new(value);
    (path.parent() == Some(directory) && path.extension().is_some_and(|ext| ext == "mp4"))
        .then_some(path)
}

fn storage_error(error: impl std::fmt::Display) -> ServiceError {
    ServiceError::new("SERVICE_ERROR", format!("离线下载存储失败：{error}"))
}

fn task_not_found() -> ServiceError {
    ServiceError::new("NOT_FOUND", "下载任务不存在")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn reads_existing_downloads_and_recovers_interrupted_tasks() {
        let directory = tempfile::tempdir().unwrap();
        let movie = directory.path().join("123-456-task.mp4");
        fs::write(&movie, b"media").unwrap();
        let item = json!({
            "id": "task",
            "seriesId": "123", "episodeId": "456", "title": "旧版短剧",
            "episodeIndex": 2, "quality": "720p", "codec": "h264",
            "status": "completed", "bytes": 5, "createdAt": 1, "filePath": movie,
        });
        let mut interrupted = item.clone();
        interrupted["id"] = json!("interrupted");
        interrupted["status"] = json!("downloading");
        interrupted["createdAt"] = json!(2);
        interrupted["filePath"] = json!("");
        fs::write(
            directory.path().join("tasks.json"),
            json!([item, interrupted]).to_string(),
        )
        .unwrap();

        let downloads = Downloads::open_at(directory.path().to_owned()).unwrap();
        assert_eq!(downloads.list()["items"][0]["status"], "failed");
        assert!(downloads.list()["items"][1].get("filePath").is_none());
        let (data, metadata) = downloads.play(&json!({"id": "task"})).await.unwrap();
        assert_eq!(data, "media");
        assert_eq!(metadata["episode"]["index"], 2);
    }
}
