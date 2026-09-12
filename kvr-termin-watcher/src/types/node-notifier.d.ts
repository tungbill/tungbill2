// Minimal typings for the subset of node-notifier we use (the package ships no types).
declare module 'node-notifier' {
  interface Notification {
    title?: string;
    message: string;
    sound?: boolean | string;
    wait?: boolean;
    appID?: string;
    icon?: string;
  }
  type Callback = (err: Error | null, response: string, metadata?: Record<string, unknown>) => void;
  interface Notifier {
    notify(notification: Notification, callback?: Callback): void;
  }
  const notifier: Notifier;
  export default notifier;
}
