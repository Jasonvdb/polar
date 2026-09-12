export type PaykitImageStatus =
  | 'checking'
  | 'needed'
  | 'building'
  | 'ready'
  | 'failed'
  | 'cancelled';
export type PaykitImagePhase =
  | 'verifying-context'
  | 'checking-docker'
  | 'checking-image'
  | 'building-image'
  | 'verifying-image';
export type PaykitImageErrorCode =
  | 'context-invalid'
  | 'docker-unavailable'
  | 'architecture-unsupported'
  | 'build-failed'
  | 'image-invalid'
  | 'cancelled';

export interface PaykitImageSetupState {
  status: PaykitImageStatus;
  jobId?: string;
  phase?: PaykitImagePhase;
  message: string;
  progress?: number;
  recentOutput: string[];
  imageTag?: string;
  error?: { code: PaykitImageErrorCode; message: string };
}

export type PaykitImageRequest =
  | { action: 'status'; replyTo?: string }
  | { action: 'build'; replyTo?: string }
  | { action: 'cancel'; jobId: string; replyTo?: string };

export interface PaykitImageManifestFile {
  path: string;
  size: number;
  sha256: string;
}
export interface PaykitImageManifest {
  schemaVersion: 1;
  appVersion: string;
  imageTag: string;
  contextDigest: string;
  supportedArchitectures: Array<'amd64' | 'arm64'>;
  files: PaykitImageManifestFile[];
}
