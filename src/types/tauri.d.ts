declare module '@tauri-apps/api/tauri' {
  export function invoke<T = any>(cmd: string, payload?: any): Promise<T>;
}
