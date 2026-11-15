// [DEBUG-playback-validation] Native playback observation; no upstream URL/key logging.
import { mount, signal, Text, View, Video, type VideoRef } from "nsh";
import { preparedPlayback } from "../../.tmp/prepared-playback";
import { Button } from "../../src/ui/controls";
function RealPlayback() {
 const status = signal("加载中"), paused = signal(false), position = signal(0), duration = signal(0);
 let ref: VideoRef | undefined, reported = false, seekVerified = false;
 return <View class="flex-1 bg-background p-4 gap-3">
  <Text class="text-xl text-foreground">{preparedPlayback.title} · 第一集真实播放验证</Text>
  <Video ref={node => ref = node} src={preparedPlayback.mediaUrl} paused={paused()} controls class="flex-1"
   onLoad={e => {duration.set(e.duration);status.set("已加载");console.log("[DEBUG-playback-validation] loaded", JSON.stringify(e));}}
   onProgress={e => {position.set(e.currentTime);duration.set(e.duration);if(!reported && e.currentTime>3){reported=true;console.log("[DEBUG-playback-validation] advancing",JSON.stringify(e));ref?.seek(60);}if(reported && !seekVerified && e.currentTime>60){seekVerified=true;console.log("[DEBUG-playback-validation] seek-resumed",JSON.stringify(e));}}}
   onError={e => {status.set(e.message);console.log("[DEBUG-playback-validation] error",e.code || "PLAYER_ERROR");}} />
  <View class="flex-row items-center gap-3"><Button label={paused()?"继续":"暂停"} onPress={()=>paused.set(!paused())}/><Button label="跳到 60 秒" onPress={()=>ref?.seek(60)}/><Text class="text-foreground">{status()} · {Math.floor(position())}/{Math.floor(duration())}秒</Text></View>
 </View>;
}
mount(RealPlayback);
