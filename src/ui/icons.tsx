import { Image, token } from "nsh";
import { Button as BaseButton } from "nsh/base";
import play from "../assets/icons/play.svg";
import pause from "../assets/icons/pause.svg";
import compass from "../assets/icons/compass.svg";
import search from "../assets/icons/search.svg";
import cup from "../assets/icons/cup.svg";
import spark from "../assets/icons/spark.svg";
import history from "../assets/icons/history.svg";
import bell from "../assets/icons/bell.svg";
import download from "../assets/icons/download.svg";
import settings from "../assets/icons/settings.svg";
import user from "../assets/icons/user.svg";
import chevron_left from "../assets/icons/chevron-left.svg";
import chevron_right from "../assets/icons/chevron-right.svg";
import chevron_up from "../assets/icons/chevron-up.svg";
import chevron_down from "../assets/icons/chevron-down.svg";
import heart from "../assets/icons/heart.svg";
import star from "../assets/icons/star.svg";
import volume from "../assets/icons/volume.svg";
import mute from "../assets/icons/mute.svg";
import expand from "../assets/icons/expand.svg";
import share from "../assets/icons/share.svg";
import close from "../assets/icons/close.svg";
import list from "../assets/icons/list.svg";
import info from "../assets/icons/info.svg";
import refresh from "../assets/icons/refresh.svg";
import sun from "../assets/icons/sun.svg";
import moon from "../assets/icons/moon.svg";
const icons = {"play": play, "pause": pause, "compass": compass, "search": search, "cup": cup, "spark": spark, "history": history, "bell": bell, "download": download, "settings": settings, "user": user, "chevron-left": chevron_left, "chevron-right": chevron_right, "chevron-up": chevron_up, "chevron-down": chevron_down, "heart": heart, "star": star, "volume": volume, "mute": mute, "expand": expand, "share": share, "close": close, "list": list, "info": info, "refresh": refresh, "sun": sun, "moon": moon};
export type IconName = keyof typeof icons;
export function Icon(props: { name: IconName; size?: number; color?: "foreground" | "muted-foreground" | "primary" | "media-foreground" }) {
 return <Image src={icons[props.name]} style={{ width: props.size ?? 20, height: props.size ?? 20, tintColor: token(props.color ?? "muted-foreground") }} />;
}
export function IconButton(props: { icon: IconName; label: string; onPress: () => void; active?: boolean; media?: boolean; size?: number; disabled?: boolean; testID?: string }) {
 return <BaseButton testID={props.testID} accessibilityLabel={props.label} tooltip={props.label} disabled={props.disabled} selected={props.active} onPress={props.onPress} class="items-center justify-center rounded-lg hover:bg-muted/40 active:opacity-60 focus:border-ring disabled:opacity-35" style={{ width: props.size ?? 36, height: props.size ?? 36 }}>
  <Icon name={props.icon} color={props.active ? "primary" : props.media ? "media-foreground" : "muted-foreground"} size={(props.size ?? 36) > 40 ? 28 : 20} />
 </BaseButton>;
}
