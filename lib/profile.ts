import * as fs from 'fs';
import * as path from 'path';
import { BskyAgent } from '@atproto/api';
import { createHash } from 'crypto';

const CACHE_VERSION = '1';
const CACHE_EXPIRE_MILLIS = 24 * 60 * 60 * 1000;
const GET_PROFILES_MAX_IDENTIFIERS = 25;

export class Profile {
  did: string;
  handle: string;
  displayName?: string;
  followersCount?: number;

  constructor(did: string, handle: string, displayName?: string, followersCount?: number) {
    this.did = did;
    this.handle = handle;
    this.displayName = displayName;
    this.followersCount = followersCount;
  }
}

export class ProfileFetcher {
  agent: BskyAgent;
  cache: ProfileCache = new ProfileCache();

  constructor(agent: BskyAgent) {
    this.agent = agent;
  }

  async fetch(identifiers: Array<string>, withCache: boolean=true): Promise<Array<Profile>> {
    const result: Array<Profile> = [];
    let identifiersToGetByAgent = [];
    if (withCache) {
      for (const identifier of identifiers) {
        const profileFromCache = this.cache.get(identifier);
        if (profileFromCache !== undefined) {
          result.push(profileFromCache);
        } else {
          identifiersToGetByAgent.push(identifier);
        }
      }
    } else {
      identifiersToGetByAgent = identifiers;
    }
    if (identifiersToGetByAgent.length >= 1) {
      const profilesByAgent = await this.getByAgent(identifiersToGetByAgent);
      for (const profile of profilesByAgent) {
        this.cache.store(profile.did, profile);
        result.push(profile);
      }
    }
    return result;
  }

  private async getByAgent(identifiers: Array<string>): Promise<Array<Profile>> {
    const result: Array<Profile> = [];
    for (let i=0; i<identifiers.length; i+=GET_PROFILES_MAX_IDENTIFIERS) {
      const response = await this.agent.getProfiles({actors: identifiers.slice(i, i+GET_PROFILES_MAX_IDENTIFIERS)});
      response.data.profiles.map(p => result.push(new Profile(p.did, p.handle, p.displayName, p.followersCount)));
    }
    return result;
  }
}

class ProfileCache {
  private rootDirectory: string;

  constructor() {
    this.rootDirectory = path.resolve(__dirname, '../.cache/profile');
    
    try {
      fs.mkdirSync(this.rootDirectory, {recursive: true, mode: '0700'});
    } catch(err: any) {
      if (err['code'] !== 'EEXIST') {
        throw err;
      }
    }
  }

  store(did: string, profile: Profile) {
    const cacheFilePath = this.getCacheFilePath(did);
    fs.writeFileSync(cacheFilePath, JSON.stringify(new CacheEntry(CACHE_VERSION, profile)));
  }

  get(did: string): Profile | undefined {
    const cacheFilePath = this.getCacheFilePath(did);
    if (!this.isCacheHit(cacheFilePath)) {
      return undefined;
    }
    const entry = JSON.parse(fs.readFileSync(cacheFilePath, {encoding: 'utf8'})) as CacheEntry;
    if (entry.version != CACHE_VERSION) {
      return undefined;
    }
    return entry.profile;
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
  profile: Profile;

  constructor(version: string, profile: Profile) {
    this.version = version;
    this.profile = profile;
  }
}
