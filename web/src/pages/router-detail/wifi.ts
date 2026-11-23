export interface WifiRadio {
  name: string;
  type?: string;
  path?: string;
  band?: string;
  channel?: string;
  htmode?: string;
  country?: string;
  txpower?: string;
  disabled: boolean;
}

export interface WifiInterface {
  name: string;
  device: string;
  mode: string;
  network: string;
  ssid: string;
  encryption: string;
  key_set: boolean;
  hidden: boolean;
  disabled: boolean;
  isolate: boolean;
  ifname?: string;
  wds?: boolean;
}

export interface WifiState {
  radios: WifiRadio[];
  interfaces: WifiInterface[];
  hardware?: {
    present: boolean;
    phys?: string[];
    interfaces?: string[];
    configured_radios?: string[];
  };
}

export const WIFI_KEY_ENCRYPTIONS = new Set([
  'psk',
  'psk2',
  'psk-mixed',
  'sae',
  'sae-mixed',
]);

export function wifiEncryptionLabel(value: string): string {
  switch (value) {
    case 'none':
      return 'без пароля';
    case 'psk':
      return 'WPA-PSK';
    case 'psk2':
      return 'WPA2-PSK';
    case 'psk-mixed':
      return 'WPA/WPA2 mixed';
    case 'sae':
      return 'WPA3-SAE';
    case 'sae-mixed':
      return 'WPA2/WPA3 mixed';
    default:
      return value || 'не задано';
  }
}
