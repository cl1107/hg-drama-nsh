import process from "process";
import { serviceConfig as devConfig } from "../.tmp/service-config";

const { HG_NSH_SERVICE_URL, HG_NSH_SERVICE_TOKEN } = process.env;
export const serviceConfig = HG_NSH_SERVICE_URL && HG_NSH_SERVICE_TOKEN
  ? { baseUrl: HG_NSH_SERVICE_URL, token: HG_NSH_SERVICE_TOKEN }
  : devConfig;

export function hasService(): boolean {
  return Boolean(serviceConfig.baseUrl && serviceConfig.token);
}

export async function servicePost<T>(
  path: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  if (!hasService()) {
    throw new Error("请先运行 ./tools/dev 启动本机服务");
  }
  const response = await fetch(`${serviceConfig.baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${serviceConfig.token}`,
    },
    body: JSON.stringify(body),
    signal,
  });
  const data: unknown = await response.json();
  if (!response.ok) {
    const err = data as { message?: string } | null;
    throw new Error(typeof err?.message === "string" ? err.message : `服务请求失败（HTTP ${response.status}）`);
  }
  return data as T;
}

export async function serviceGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  if (!hasService()) {
    throw new Error("请先运行 ./tools/dev 启动本机服务");
  }
  const response = await fetch(`${serviceConfig.baseUrl}${path}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${serviceConfig.token}`,
    },
    signal,
  });
  const data: unknown = await response.json();
  if (!response.ok) {
    const err = data as { message?: string } | null;
    throw new Error(typeof err?.message === "string" ? err.message : `服务请求失败（HTTP ${response.status}）`);
  }
  return data as T;
}
