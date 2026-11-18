import { GlobalPlayer } from "./GlobalPlayer";
export function Player(props: { onBack?: () => void; onNotify?: (message: string) => void }) {
 return <GlobalPlayer onNotify={message=>props.onNotify?.(message)} onFind={()=>props.onBack?.()} onBack={props.onBack} />;
}
