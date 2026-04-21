import crypto from 'node:crypto';

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function maintainAsyncJob(jobExecuter: () => Promise<void>, restartDelay: number) {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  while (true) {
    try {
      await jobExecuter();
    } catch (e) {
      console.log(e);
      console.log('Job restarting !!!');
    } finally {
      await wait(restartDelay);
    }
  }
}

export function uuid() {
  return crypto.randomUUID();
}
