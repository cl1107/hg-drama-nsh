// [DEBUG-playback-validation] Fixed public series for a reproducible service/UI flow.
import { mount, View } from "nsh";
import { Button } from "../../src/ui/controls";
import { Player } from "../../src/features/player/Player";
import { startPlayback } from "../../src/features/player/session";
function Flow() {
 return <View class="flex-1 bg-background p-4 gap-3"><Button label="播放验证短剧" onPress={() => void startPlayback("7503745441910017049")} /><Player /></View>;
}
mount(Flow);
