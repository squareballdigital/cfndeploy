import { Parameter } from '@aws-sdk/client-cloudformation';

export type SetParameterValue = Parameter | string | undefined;

export type SetParameterValues<K extends string = string> = {
  [P in K]?: SetParameterValue;
};

export type ParameterValueProvider = () =>
  | SetParameterValue
  | PromiseLike<SetParameterValue>;

export type ParameterValueProviders<K extends string = string> = {
  [P in K]?: SetParameterValue | ParameterValueProvider;
};

export function setParameters(
  parameters: Record<string, Parameter>,
  values: SetParameterValues,
  defaults = false,
): void {
  for (const [key, param] of Object.entries(values)) {
    const existing = parameters[key];
    const hasValue = existing?.ParameterValue !== undefined;

    if ((defaults && hasValue) || param === undefined) {
      continue;
    }
    const value = typeof param === 'string' ? param : param.ParameterValue;

    parameters[key] = {
      ...existing,
      ParameterValue: value,
    };
  }
}

export async function setProvideParameters(
  parameters: Record<string, Parameter>,
  values: ParameterValueProviders,
  defaults = false,
): Promise<void> {
  for (const [key, paramOrProvider] of Object.entries(values)) {
    const existing = parameters[key];
    if ((defaults && existing) || paramOrProvider === undefined) {
      continue;
    }

    const param =
      typeof paramOrProvider === 'function'
        ? await paramOrProvider()
        : paramOrProvider;

    if (!param) {
      continue;
    }

    const value = typeof param === 'string' ? param : param.ParameterValue;

    parameters[key] = {
      ...existing,
      ParameterValue: value,
    };
  }
}
