import { Credentials, Provider } from '@aws-sdk/types';

export interface AwsCommonServiceConfig {
  credentials?: Credentials | Provider<Credentials>;
  region?: string;
}
