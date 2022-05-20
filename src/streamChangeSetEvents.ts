import {
  CloudFormationClient,
  paginateDescribeStackEvents,
  StackEvent,
} from '@aws-sdk/client-cloudformation';
import { assertCondition } from './internal/assertCondition.js';
import { delay } from './internal/delay.js';

export async function* streamChangeSetEvents(
  client: CloudFormationClient,
  stackId: string,
  token?: string,
): AsyncIterableIterator<StackEvent> {
  let rewind: StackEvent[] | undefined = await reverse(
    getEventsReverse(
      client,
      stackId,
      (event) =>
        !!event.ClientRequestToken && event.ClientRequestToken === token,
      (event) => {
        if (token) {
          return event.ClientRequestToken !== token;
        } else {
          token = event.ClientRequestToken;
          return false;
        }
      },
    ),
  );

  if (!rewind.length) {
    return;
  }
  yield* rewind;

  let last = rewind[rewind.length - 1].EventId;
  rewind = undefined;

  const eventsFilter = (event: StackEvent): boolean =>
    event.ClientRequestToken === token;
  const eventsStop = (event: StackEvent): boolean => event.EventId === last;

  for (;;) {
    const events = await reverse(
      getEventsReverse(client, stackId, eventsFilter, eventsStop),
    );
    if (events.length) {
      last = events[events.length - 1].EventId;
      yield* events;
    }
    await delay(1000);
  }
}

async function reverse<T>(iterator: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];

  for await (const item of iterator) {
    items.unshift(item);
  }
  return items;
}

async function* getEventsReverse(
  client: CloudFormationClient,
  stackId: string,
  filter: (event: StackEvent) => boolean,
  stop: (event: StackEvent) => boolean,
): AsyncIterableIterator<StackEvent> {
  const pages = paginateDescribeStackEvents(
    {
      client,
    },
    {
      StackName: stackId,
    },
  );

  for await (const page of pages) {
    assertCondition(page.StackEvents);

    for (const event of page.StackEvents) {
      if (stop(event)) {
        return;
      }
      if (filter(event)) {
        yield event;
      }
    }
  }
}
