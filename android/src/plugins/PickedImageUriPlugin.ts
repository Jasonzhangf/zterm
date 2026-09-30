import { Capacitor, registerPlugin } from '@capacitor/core';

export interface PickedImageFileResult {
  dataBase64: string;
  mime: string;
  name: string;
  size: number;
}

export interface PickedImageSelection {
  uri: string;
  mimeType: string;
  name: string;
}

export interface PickedImageUriNativePlugin {
  pickImage(): Promise<PickedImageSelection | null>;
  readContentUri(options: {
    uri: string;
    mimeType: string;
    name: string;
  }): Promise<PickedImageFileResult>;
}

const PickedImageUriNative =
  registerPlugin<PickedImageUriNativePlugin>('PickedImageUri');

export function isPickedImageUriReadSupported() {
  return Capacitor.getPlatform() === 'android';
}

export function pickPickedImage(): Promise<PickedImageSelection | null> {
  return PickedImageUriNative.pickImage();
}

export function readPickedImageFileResult(options: {
  uri: string;
  mimeType: string;
  name: string;
}): Promise<PickedImageFileResult> {
  return PickedImageUriNative.readContentUri(options);
}

export async function readPickedImageFile(options: {
  uri: string;
  mimeType: string;
  name: string;
}): Promise<File | null> {
  if (!isPickedImageUriReadSupported()) {
    return null;
  }
  const result = await readPickedImageFileResult(options);
  if (!result.dataBase64 || result.size <= 0) {
    return null;
  }
  return new File(
    [Uint8Array.from(atob(result.dataBase64), (character) => character.charCodeAt(0))],
    result.name,
    { type: result.mime },
  );
}

export const PickedImageUriPlugin = PickedImageUriNative;
