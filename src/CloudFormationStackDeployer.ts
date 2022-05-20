import {
  CloudFormationClient,
  CloudFormationClientConfig,
  CreateChangeSetCommand,
  DescribeChangeSetCommand,
  DescribeChangeSetOutput,
  ExecuteChangeSetCommand,
  paginateDescribeStacks,
  Stack,
  StackEvent,
} from '@aws-sdk/client-cloudformation';
import { GetObjectCommand, S3Client, S3ClientConfig } from '@aws-sdk/client-s3';
import { AdaptiveRetryStrategy } from '@aws-sdk/middleware-retry';
import { assert } from '@fmtk/decoders';
import { ParameterDefinition } from '@squareball/cfntemplate';
import stream from 'stream';
import { TypedEmitter } from 'tiny-typed-emitter';
import { v4 as uuid } from 'uuid';
import { BaseTemplate, decodeBaseTemplate } from './BaseTemplate.js';
import { AwsCommonServiceConfig } from './CommonServiceConfig.js';
import { DownloadTemplateProgressStats } from './DownloadTemplateProgressStats.js';
import { assertCondition } from './internal/assertCondition.js';
import { delay } from './internal/delay.js';
import { stripUndefined } from './internal/stripUndefined.js';
import { ParameterValue } from './ParameterValue.js';
import {
  ParameterValueProviders,
  setParameters,
  SetParameterValues,
  setProvideParameters,
} from './setParameters.js';
import { streamChangeSetEvents } from './streamChangeSetEvents.js';
import { TemplateLocation } from './TemplateLocation.js';

export interface CreateChangeSetOptions<P extends string = string> {
  name?: string;
  parameterDefaults?: SetParameterValues<P>;
  parameters?: SetParameterValues<P>;
  provideParameterDefaults?: ParameterValueProviders<P>;
  provideParameters?: (
    current: Record<P, ParameterValue>,
  ) => SetParameterValues<P> | PromiseLike<SetParameterValues<P>>;
}

export enum ChangeSetCreateStatus {
  ChangeSetCreateComplete = 'ChangeSetCreateComplete',
  ChangeSetCreateInProgress = 'ChangeSetCreateInProgress',
  ChangeSetCreating = 'ChangeSetCreating',
  DescribeStack = 'DescribeStack',
  PrepareParameters = 'PrepareParameters',
}

export enum ChangeSetExecuteStatus {
  ChangeSetCreateComplete = 'ChangeSetCreateComplete',
  ChangeSetCreateInProgress = 'ChangeSetCreateInProgress',
  ChangeSetCreating = 'ChangeSetCreating',
  DescribeStack = 'DescribeStack',
  PrepareParameters = 'PrepareParameters',
}

export enum CloudFormationStackEventKey {
  ChangeSetCreateStatus = 'ChangesetCreateStatus',
  DownloadTemplateProgress = 'DownloadTemplateProgress',
  ExecuteEvent = 'ExecuteEvent',
}

export interface CloudFormationStackEvents {
  [CloudFormationStackEventKey.ChangeSetCreateStatus](
    status: ChangeSetCreateStatus,
    changeset?: DescribeChangeSetOutput,
  ): void;
  [CloudFormationStackEventKey.DownloadTemplateProgress](
    stats: DownloadTemplateProgressStats,
  ): void;
  [CloudFormationStackEventKey.ExecuteEvent](event: StackEvent): void;
}

export class CloudFormationStackDeployer extends TypedEmitter<CloudFormationStackEvents> {
  private readonly cfn: CloudFormationClient;
  private readonly s3: S3Client;
  private readonly stackName: string;
  private readonly templateLocation: TemplateLocation | undefined;
  private _changeset: DescribeChangeSetOutput | undefined;
  private _template: BaseTemplate | undefined;

  public get changeset(): DescribeChangeSetOutput | undefined {
    return this._changeset;
  }
  private set changeset(value: DescribeChangeSetOutput | undefined) {
    this._changeset = value;
  }

  constructor(dep: {
    awsConfig?: AwsCommonServiceConfig;
    cfn?: CloudFormationClient;
    cfnConfig?: CloudFormationClientConfig;
    s3?: S3Client;
    s3Config?: S3ClientConfig;
    stackName: string;
    template?: TemplateLocation;
  }) {
    super();
    this.stackName = dep.stackName;
    this.templateLocation = dep.template;

    this.cfn =
      dep.cfn ??
      new CloudFormationClient({
        retryStrategy:
          dep.cfnConfig?.retryStrategy ??
          new AdaptiveRetryStrategy(async () => 10, {
            delayDecider: (base, attempt) => base * 2 ** attempt,
          }),
        ...dep.awsConfig,
        ...dep.cfnConfig,
      });

    this.s3 =
      dep.s3 ??
      new S3Client({
        ...dep.awsConfig,
        ...dep.s3Config,
      });
  }

  /**
   * Create a changeset for the stack.
   */
  public async createChangeSet(
    opts: CreateChangeSetOptions = {},
  ): Promise<DescribeChangeSetOutput> {
    const template = await this.getTemplate();
    const parameters: Record<string, ParameterValue> = {};

    const templateParams = (template as any).Parameters as Record<
      string,
      ParameterDefinition
    >;

    this.emit(
      CloudFormationStackEventKey.ChangeSetCreateStatus,
      ChangeSetCreateStatus.DescribeStack,
    );
    const existing = await this.getStack();

    this.emit(
      CloudFormationStackEventKey.ChangeSetCreateStatus,
      ChangeSetCreateStatus.PrepareParameters,
    );

    assertCondition(this.templateLocation);

    // set the parameters for the assets
    if (template.Metadata.DeployAssetManifest) {
      for (const asset of template.Metadata.DeployAssetManifest.assets) {
        parameters[asset.bucketParam] = {
          ParameterValue: this.templateLocation.S3Bucket,
        };
        parameters[asset.keyParam] = { ParameterValue: asset.key };
      }
    }

    // get the existing parameter values
    if (existing?.Parameters) {
      for (const key of Object.keys(templateParams)) {
        const oldValue = existing.Parameters.find(
          (x) => x.ParameterKey === key,
        );
        if (!oldValue) {
          continue;
        }
        const newValue = parameters[key];

        parameters[key] = {
          ...newValue,
          UsePreviousValue: oldValue && !newValue,
          PreviousValue: oldValue.ParameterValue,
        };
      }
    }

    // set the parameter values according to the options
    if (opts.parameters) {
      setParameters(parameters, opts.parameters);
    }
    if (opts.provideParameters) {
      setParameters(parameters, await opts.provideParameters(parameters));
    }
    if (opts.parameterDefaults) {
      setParameters(parameters, opts.parameterDefaults, true);
    }
    if (opts.provideParameterDefaults) {
      await setProvideParameters(
        parameters,
        opts.provideParameterDefaults,
        true,
      );
    }

    // validate the parameter names
    const invalid = Object.keys(parameters).filter(
      (x) => !(x in templateParams),
    );
    if (invalid.length) {
      throw new Error(`invalid parameter keys: ${invalid.join(', ')}`);
    }

    // make sure we have values for all required parameters
    const notSet = Object.keys(templateParams).filter(
      (x) =>
        templateParams[x].Default === undefined &&
        (!(x in parameters) ||
          (parameters[x].ParameterValue === undefined &&
            !parameters[x].UsePreviousValue)),
    );
    if (notSet.length) {
      throw new Error(`required parameters not set: ${notSet.join(', ')}`);
    }

    // create changeset
    let status = ChangeSetCreateStatus.ChangeSetCreating;
    this.emit(CloudFormationStackEventKey.ChangeSetCreateStatus, status);

    const result = await this.cfn.send(
      new CreateChangeSetCommand({
        Capabilities: ['CAPABILITY_NAMED_IAM'],
        ChangeSetName:
          opts.name ??
          `${this.stackName}-${
            template.Metadata.DeployStackVersion
          }-${Date.now()}`,
        ChangeSetType: existing ? 'UPDATE' : 'CREATE',
        Parameters: Object.entries(parameters).map(([key, value]) =>
          stripUndefined({
            ParameterKey: key,
            ParameterValue: value.ParameterValue,
            UsePreviousValue:
              value.ParameterValue === undefined && value.UsePreviousValue,
          }),
        ),
        StackName: this.stackName,
        TemplateURL: `https://${this.templateLocation.S3Bucket}.s3.amazonaws.com/${this.templateLocation.S3Key}`,
      }),
    );

    if (!result.Id) {
      throw new Error(`unexpected response`);
    }

    const changesetId = result.Id;
    let changeset: DescribeChangeSetOutput;

    do {
      await delay(2000);

      changeset = await this.cfn.send(
        new DescribeChangeSetCommand({
          ChangeSetName: changesetId,
          StackName: this.stackName,
        }),
      );

      switch (changeset.Status) {
        case 'FAILED':
          throw new Error(
            `changeset creation failed: ${
              changeset.StatusReason ?? 'unknown error'
            }`,
          );

        case 'CREATE_IN_PROGRESS':
          if (status !== ChangeSetCreateStatus.ChangeSetCreateInProgress) {
            status = ChangeSetCreateStatus.ChangeSetCreateInProgress;
            this.emit(
              CloudFormationStackEventKey.ChangeSetCreateStatus,
              status,
              changeset,
            );
          }
          break;

        case 'CREATE_COMPLETE':
          status = ChangeSetCreateStatus.ChangeSetCreateComplete;
          this.emit(
            CloudFormationStackEventKey.ChangeSetCreateStatus,
            status,
            changeset,
          );
          break;
      }
    } while (status !== ChangeSetCreateStatus.ChangeSetCreateComplete);

    this.changeset = changeset;
    return changeset;
  }

  /**
   * Execute the changeset.
   */
  public async executeChangeSet(): Promise<boolean> {
    if (!this.changeset) {
      throw new Error(`no changeset ready: call createChangeSet first`);
    }

    assertCondition(
      this.changeset.ChangeSetId &&
        this.changeset.StackId &&
        this.changeset.Changes,
    );

    const token = uuid();

    await this.cfn.send(
      new ExecuteChangeSetCommand({
        ChangeSetName: this.changeset.ChangeSetId,
        ClientRequestToken: token,
        StackName: this.changeset.StackId,
      }),
    );

    return this.streamEvents(this.changeset.StackId, token);
  }

  /**
   * Stream events for the changeset.
   */
  public async streamEvents(stackId: string, token?: string): Promise<boolean> {
    const events = streamChangeSetEvents(this.cfn, stackId, token);

    for await (const event of events) {
      this.emit(CloudFormationStackEventKey.ExecuteEvent, event);

      if (event.LogicalResourceId === event.StackName) {
        if (event.ResourceStatus?.endsWith('FAILED')) {
          return false;
        }
        if (event.ResourceStatus?.endsWith('COMPLETE')) {
          return !event.ResourceStatus.includes('ROLLBACK');
        }
      }
    }

    // we shouldn't get here, but let's guess it succeeded
    return true;
  }

  /**
   * Get the existing stack info, if any.
   */
  private async getStack(): Promise<Stack | undefined> {
    const stackPages = paginateDescribeStacks(
      {
        client: this.cfn,
      },
      {},
    );

    for await (const page of stackPages) {
      if (!page.Stacks) {
        return;
      }
      for (const stack of page.Stacks) {
        if (
          stack.StackName === this.stackName &&
          !['REVIEW_IN_PROGRESS', 'DELETE_COMPLETE'].includes(
            stack.StackStatus as string,
          )
        ) {
          return stack;
        }
      }
    }
  }

  /**
   * Download and validate the template data.
   */
  private async getTemplate(): Promise<BaseTemplate> {
    if (!this.templateLocation) {
      throw new Error(`template location has not been set`);
    }
    if (this._template) {
      return this._template;
    }

    const progress: DownloadTemplateProgressStats = {
      location: this.templateLocation,
    };
    this.emit(CloudFormationStackEventKey.DownloadTemplateProgress, progress);

    const response = await this.s3.send(
      new GetObjectCommand({
        Bucket: this.templateLocation.S3Bucket,
        Key: this.templateLocation.S3Key,
      }),
    );

    progress.progress = 0;
    progress.total = response.ContentLength;
    this.emit(CloudFormationStackEventKey.DownloadTemplateProgress, progress);

    const responseStream = response.Body as stream.Readable;
    const chunks: Buffer[] = [];

    for await (const chunk of responseStream) {
      chunks.push(chunk);
      progress.progress += chunk.length;
      this.emit(CloudFormationStackEventKey.DownloadTemplateProgress, progress);
    }

    progress.complete = true;
    this.emit(CloudFormationStackEventKey.DownloadTemplateProgress, progress);

    const template = JSON.parse(Buffer.concat(chunks).toString());
    this._template = assert(decodeBaseTemplate, template);

    return this._template;
  }
}
