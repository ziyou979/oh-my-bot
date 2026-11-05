// Channel registry. Feishu, Discord and WeChat Work are planned; docs/architecture.md says what each needs.
import type { ChannelAdapter } from "../core/plugins";
import { telegram } from "./telegram";

export const CHANNELS: Record<string, ChannelAdapter> = { [telegram.id]: telegram };
