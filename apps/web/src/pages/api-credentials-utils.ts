export const PHOTONPAY_DEFAULT_BASE_URL = 'https://x-api.photonpay.com';

export type CredentialPayloadField = {
  key?: string;
  value?: string;
};

export function photonPayDefaultFields(): CredentialPayloadField[] {
  return [
    { key: 'appId', value: '' },
    { key: 'appSecret', value: '' },
    { key: 'baseUrl', value: PHOTONPAY_DEFAULT_BASE_URL },
    { key: 'settlementDelayDays', value: '10' },
  ];
}
