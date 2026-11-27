import { Video, nativeComponent, type VideoProps } from "nsh";
import type { ResolvedVariant } from "../../providers/source-resolver/types";

const Bytevc2Video = nativeComponent<
  { src: string; paused: boolean; muted: boolean; rate: number },
  {
    load: { duration: number };
    progress: { currentTime: number; duration: number };
    error: { code: string; message: string };
    end: Record<string, never>;
  }
>("hg.bytevc2-video", {
  props: ["src", "paused", "muted", "rate"],
  events: ["load", "progress", "error", "end"],
});

export interface PlayerVideoRef {
  seek(seconds: number): void;
}

type PlayerVideoProps = Pick<VideoProps,
  "testID" | "src" | "paused" | "muted" | "rate" | "class" | "style" | "onProgress" | "onError" | "onEnd"
> & {
  codec: ResolvedVariant["codec"];
  onLoad?: (event: { duration: number }) => void;
  ref: (node: PlayerVideoRef) => void;
};

/** Both backends retain the same playback session, controls and progress events. */
export function PlayerVideo(props: PlayerVideoProps) {
  return (
    <If when={props.codec === "bytevc2"} else={
      <Video
        testID={props.testID}
        ref={node => props.ref(node)}
        src={props.src}
        paused={props.paused}
        muted={props.muted}
        rate={props.rate}
        controls={false}
        class={props.class}
        style={props.style}
        onLoad={props.onLoad}
        onProgress={props.onProgress}
        onError={props.onError}
        onEnd={props.onEnd}
      />
    }>
      <Bytevc2Video
        testID={props.testID}
        ref={node => props.ref({ seek: seconds => node.command("seek", { seconds }) })}
        src={props.src}
        paused={props.paused ?? false}
        muted={props.muted ?? false}
        rate={props.rate ?? 1}
        class={props.class}
        style={props.style}
        onLoad={props.onLoad}
        onProgress={props.onProgress}
        onError={props.onError}
        onEnd={props.onEnd}
      />
    </If>
  );
}
