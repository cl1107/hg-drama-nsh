import { GlobalPlayer } from "../player/GlobalPlayer";
export function RecommendView(props: { onNotify: (message: string) => void; onFind: () => void; onLogin: () => void }) {
 return <GlobalPlayer recommend onNotify={props.onNotify} onFind={props.onFind} />;
}
