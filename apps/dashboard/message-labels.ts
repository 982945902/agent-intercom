import type { DeliveryState, Message } from '../../packages/sdk/index.js';

export const deliveryLabels: Record<DeliveryState, string> = {
  queued: 'Queued',
  adapter_received: 'Adapter received',
  host_accepted: 'Host accepted',
  rejected: 'Rejected',
  delivery_unknown: 'Delivery unknown',
  expired: 'Expired',
};

export const kindLabels: Record<Message['kind'], string> = {
  send: 'Direct',
  broadcast: 'Broadcast',
  ask: 'Ask',
  reply: 'Reply',
  late_reply: 'Late reply',
};
