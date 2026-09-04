export type LocalDevice = {
  deviceId: string;
  displayName: string;
};

export type Snapshot = {
  localDevice: LocalDevice | null;
};
