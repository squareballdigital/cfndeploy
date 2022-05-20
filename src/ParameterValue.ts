import { Parameter } from '@aws-sdk/client-cloudformation';

export interface ParameterValue extends Parameter {
  PreviousValue?: string;
}
