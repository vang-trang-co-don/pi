import type { ProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";

export const googleCloudCodePaApi = (): ProviderStreams => lazyApi(() => import("./google-cloud-code-pa.ts"));
