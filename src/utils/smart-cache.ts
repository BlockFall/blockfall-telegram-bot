import fs from 'fs/promises';
import { Loader } from 'layered-loader';
import { createHash } from 'node:crypto';
import { type LimitFunction } from 'p-limit';
import stableStringify from './stable-stringify.ts';

export interface SmartCacheOptions {
  cacheSeconds?: number;
  cacheSize?: number;
  autoRefresh?: boolean;
  limitFunction?: LimitFunction;
  fileBackupName?: string;
}

function sha256(content: string) {
  return createHash('sha256').update(content).digest('hex');
}

function getFilePath(fileBackupName: string, key?: string) {
  if (key) {
    return `./data/cache/${fileBackupName}/${sha256(key)}.json`;
  }
  return `./data/cache/${fileBackupName}/`;
}

function paramsToKey(params: unknown): string {
  return params === undefined ? '__no_params__' : String(stableStringify(params));
}

export function makeSmartCached<ReturnType>(
  func: () => Promise<ReturnType>,
  options?: SmartCacheOptions
): () => Promise<ReturnType | null | undefined>;

export function makeSmartCached<InputType, ReturnType>(
  func: (params: InputType) => Promise<ReturnType>,
  options?: SmartCacheOptions
): (params: InputType) => Promise<ReturnType | null | undefined>;

export function makeSmartCached<InputType, ReturnType>(
  func: ((params: InputType) => Promise<ReturnType>) | (() => Promise<ReturnType>),
  options: SmartCacheOptions = {}
) {
  const { cacheSeconds = 60, cacheSize = 1_000, limitFunction, fileBackupName } = options;
  let autoRefresh = options.autoRefresh ?? false;

  if (cacheSeconds === Infinity) {
    autoRefresh = false;
  }

  const typedFunc = func as (p?: InputType) => Promise<ReturnType>;
  const rawLoader: (p?: InputType) => Promise<ReturnType> = limitFunction
    ? (p) => limitFunction(() => typedFunc(p))
    : typedFunc;

  let dataLoaderFn: (params?: InputType) => Promise<ReturnType>;

  if (fileBackupName) {
    const capturedName = fileBackupName;
    const jobPromises: Record<string, Promise<ReturnType> | undefined> = {};

    dataLoaderFn = async (params?: InputType): Promise<ReturnType> => {
      const key = paramsToKey(params);

      // ??= returns the (possibly newly assigned) value — pendingLoad is always Promise<ReturnType>
      const pendingLoad = (jobPromises[key] ??= rawLoader(params)
        .then(async (data: ReturnType) => {
          await fs.mkdir(getFilePath(capturedName), { recursive: true });
          await fs.writeFile(getFilePath(capturedName, key), JSON.stringify(data));
          return data;
        })
        .finally(() => {
          jobPromises[key] = undefined;
        }));

      let fileData: ReturnType | undefined;
      try {
        const fileContent = await fs.readFile(getFilePath(capturedName, key), 'utf-8');
        fileData = JSON.parse(fileContent) as ReturnType;
      } catch {
        fileData = undefined;
      }

      if (fileData !== undefined) return fileData;
      return pendingLoad;
    };
  } else {
    dataLoaderFn = rawLoader;
  }

  const ttlInMsecs = cacheSeconds === Infinity ? undefined : cacheSeconds * 2 * 1000;

  const loader = new Loader<ReturnType, InputType | undefined>({
    inMemoryCache: {
      cacheType: 'lru-object',
      ttlInMsecs,
      maxItems: cacheSize,
      ...(cacheSeconds !== Infinity && { ttlLeftBeforeRefreshInMsecs: cacheSeconds * 1000 }),
    },
    cacheKeyFromLoadParamsResolver: paramsToKey,
    throwIfLoadError: false,
    loadErrorHandler: (err, key) => {
      console.error(`[smart-cache] Failed to load value for key "${key ?? 'unknown'}":`, err);
    },
    dataSourceGetOneFn: (params) => dataLoaderFn(params),
  });

  const refresherTimeouts: Record<string, NodeJS.Timeout | null> = {};
  let activeTimeouts = 0;

  function getter(params?: InputType): Promise<ReturnType | null | undefined> {
    const key = paramsToKey(params);

    if (refresherTimeouts[key]) {
      clearTimeout(refresherTimeouts[key]);
      activeTimeouts--;
    }

    if (autoRefresh && activeTimeouts < cacheSize * 0.8) {
      refresherTimeouts[key] = setTimeout(
        () => {
          refresherTimeouts[key] = null;
          activeTimeouts--;
          getter(params).catch((err: unknown) => {
            console.error(`[smart-cache] Auto-refresh error for key "${key}":`, err);
          });
        },
        Math.floor(cacheSeconds * 1.5 * 1000)
      );
      activeTimeouts++;
    }

    return loader.get(params);
  }

  return getter;
}
