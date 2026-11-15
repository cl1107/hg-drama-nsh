import { mount, signal, Text, View } from "nsh";
import { Button } from "../../src/ui/controls";
function Probe() {
 const status = signal("等待运行");
 const run = async () => {
  status.set("请求中");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
   const r = await fetch("http://127.0.0.1:18791/redirect", { redirect: "manual", signal: controller.signal });
   status.set(JSON.stringify({ status: r.status, location: r.headers.get("location"), cookies: r.headers.getSetCookie() }));
  } catch (error) { status.set(String(error)); }
  finally { clearTimeout(timeout); }
 };
 return <View class="flex-1 p-6 bg-background"><Button label="运行网络探针" onPress={() => void run()} /><Text class="text-foreground">{status()}</Text></View>;
}
mount(Probe);
