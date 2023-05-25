import * as fs from 'fs';
import * as path from 'path';
import { BskyAgent } from '@atproto/api';
import { createHash } from 'crypto';
import { Profile } from './profile';

const CACHE_VERSION = '1';
const CACHE_EXPIRE_MILLIS = 24 * 60 * 60 * 1000;

export class FollowsFetcher {
  agent: BskyAgent;
  limit: number;
  cache: FollowsCache = new FollowsCache();

  constructor(agent: BskyAgent, limit: number) {
    this.agent = agent;
    this.limit = limit;
  }

  async fetch(did: string): Promise<Array<Profile>> {
    let follows = this.cache.get(did);
    if (follows === undefined) {
      try {
        follows = await this.getByAgent(did);
        this.cache.store(did, follows);
      } catch(e) {
        return [];
      }
    }
    return follows;
  }

  private async getByAgent(did: string): Promise<Array<Profile>> {
    const result: Array<Profile> = [];
    let cursor = await this.getFollows(did, undefined, result);
    while(cursor != undefined) {
      cursor = await this.getFollows(did, cursor, result);
      if (result.length >= this.limit) break;
    }
    return result;
  }

  private async getFollows(did: string, cursor: string | undefined, result: Array<Profile>): Promise<string | undefined> {
    const response = await this.agent.getFollows({actor: did, limit: 100, cursor: cursor});
    response.data.follows.map(p => result.push(new Profile(p.did, p.handle, p.displayName)));
    if (response.data.follows.length >= 100) {
      return response.data.cursor;
    } else {
      return undefined;
    }
  }
}

class FollowsCache {
  private rootDirectory = path.resolve(__dirname, '../.cache/follows');

  constructor() {
    try {
      fs.mkdirSync(this.rootDirectory, {recursive: true, mode: '0700'});
    } catch(err: any) {
      if (err['code'] !== 'EEXIST') {
        throw err;
      }
    }
  }

  store(did: string, follows: Array<Profile>) {
    const cacheFilePath = this.getCacheFilePath(did);
    fs.writeFileSync(cacheFilePath, JSON.stringify(new CacheEntry(CACHE_VERSION, follows)));
  }

  get(did: string): Array<Profile> | undefined {
    const cacheFilePath = this.getCacheFilePath(did);
    if (!this.isCacheHit(cacheFilePath)) {
      return undefined;
    }
    const entry = JSON.parse(fs.readFileSync(cacheFilePath, {encoding: 'utf8'})) as CacheEntry;
    if (entry.version != CACHE_VERSION) {
      return undefined;
    }
    return entry.follows;
  }

  private getCacheFilePath(did: string): string {
    return path.join(this.rootDirectory, this.getHash(did));
  }

  private getHash(did: string): string {
    return createHash('sha256').update(did, 'utf8').digest('hex');
  }

  private isCacheHit(cacheFilePath: string): boolean {
    try {
      const stat = fs.statSync(cacheFilePath);
      return new Date().getTime() - stat.mtime.getTime() < CACHE_EXPIRE_MILLIS;
    } catch(err) {
      return false;
    }
  }
}

class CacheEntry {
  version: string;
  follows: Array<Profile>;

  constructor(version: string, follows: Array<Profile>) {
    this.version = version;
    this.follows = follows;
  }
}
