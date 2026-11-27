import { GlobalPlayer } from "../player/GlobalPlayer";
export function RecommendView(props: { active: boolean; onNotify: (message: string) => void; onFind: () => void }) {
 return <GlobalPlayer recommend active={props.active} onNotify={props.onNotify} onFind={props.onFind} />;
}
