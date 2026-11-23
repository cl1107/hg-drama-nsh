import { LocalService } from "hg-drama/native";

function startLocalService() {
  try {
    return LocalService.connection();
  } catch (error) {
    console.error("本机服务启动失败", error);
    return { baseUrl: "", token: "" };
  }
}

export const serviceConfig = startLocalService();

export function hasService(): boolean {
  return Boolean(serviceConfig.baseUrl && serviceConfig.token);
}

export async function servicePost<T>(
  path: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  if (!hasService()) {
    throw new Error("本机服务未启动");
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
    throw new Error("本机服务未启动");
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
