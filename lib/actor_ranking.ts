import { BskyAgent } from '@atproto/api';
import { Profile, ProfileFetcher } from './profile';
import { FollowsFetcher } from './follows';

export class RankedActor {
  profile: Profile;
  rank: number;

  constructor(profile: Profile, rank: number) {
    this.profile = profile;
    this.rank = rank;
  }
}

export class ActorRankingCreatorParameters {
  yourDid: string;
  startIdentifiers: Array<string>;
  limit: number;
  maxActorsPerLevel: number;
  includeYourFollows: boolean;
  isVerbose: boolean;

  constructor(yourDid: string, startIdentifiers: Array<string>, limit: number, maxActorsPerLevel: number, includeYourFollows: boolean, isVerbose: boolean) {
    this.yourDid = yourDid;
    this.startIdentifiers = startIdentifiers;
    this.limit = limit;
    this.maxActorsPerLevel = maxActorsPerLevel;
    this.includeYourFollows = includeYourFollows;
    this.isVerbose = isVerbose;
  }
}

export class ActorRankingCreator {
  profileFetcher: ProfileFetcher;
  followsFetcher: FollowsFetcher;
  status: ActorRankingCreationStatus = new ActorRankingCreationStatus();
  actorRankCalculator: ActorRankCalculator = new ActorRankCalculator(0.9, 100);

  constructor(profileFetcher: ProfileFetcher, followsFetcher: FollowsFetcher) {
    this.profileFetcher = profileFetcher;
    this.followsFetcher = followsFetcher;
  }

  isCompleted(): boolean {
    return this.status.phase === ActorRankingCreationPhase.Completed;
  }

  getPercentage(): number {
    return this.status.getPercentage();
  }

  async create(params: ActorRankingCreatorParameters): Promise<Array<RankedActor>> {
    const followsFetcher = this.followsFetcher;
    const profiles: Map<string, Profile> = new Map();
    const actorFollows: Map<string, Array<string>> = new Map();
  
    async function fetchFollows(did: string): Promise<Array<Profile>> {
      if (params.isVerbose) {
        console.error(`fetch follows of ${did}`);
      }
      const follows = await followsFetcher.fetch(did);
      actorFollows.set(did, follows.map(p => p.did));
      for (const profile of follows) {
        profiles.set(profile.did, profile);
      }
      return follows;
    }

    try {
      if (params.isVerbose) {
        console.error(`fetch profiles of ${params.startIdentifiers}`);
      }
      const startProfiles = await this.profileFetcher.fetch(params.startIdentifiers);
      const startDids = startProfiles.map(p => p.did);
      for (const profile of startProfiles) {
        profiles.set(profile.did, profile);
      }

      if (params.isVerbose) {
        console.error("Fetch follows of start actors and select first level actors");
      }
      const firstLevelSelector = new MostFollowedActorsSelector(new Set(startDids));
      for (const did of startDids) {
        const follows = await fetchFollows(did);
        const followedProfiles = await this.profileFetcher.fetch(follows.map(p => p.did));
        firstLevelSelector.addFollows(did, followedProfiles);
      }
      const firstLevelDids = firstLevelSelector.selectMostFollowedActors(params.maxActorsPerLevel);
    
      if (params.isVerbose) {
        console.error("Fetch follows of first level actors and select second level actors");
      }
      this.status.changePhase(ActorRankingCreationPhase.SelectSecondLevelActors, firstLevelDids.length);
      const secondLevelSelector = new MostFollowedActorsSelector(new Set([...startDids, ...firstLevelDids]));
      for (const did of firstLevelDids) {
        const follows = await fetchFollows(did);
        secondLevelSelector.addFollows(did, follows);
        this.status.fetched();
      }
      const secondLevelDids = secondLevelSelector.selectMostFollowedActors(params.maxActorsPerLevel);

      if (params.isVerbose) {
        console.error("Fetch follows of second level actors");
      }
      this.status.changePhase(ActorRankingCreationPhase.FetchFollowsOfSecondLevelActors, secondLevelDids.length);
      const followGraph = new FollowGraph(startDids);
      for (const did of [...startDids, ...firstLevelDids]) {
        const follows = actorFollows.get(did);
        if (follows !== undefined) {
          followGraph.addFollows(did, follows);
        }
      }
      const allDids = new Set([
        ...startDids,
        ...firstLevelSelector.getAllFollowedDids(),
        ...secondLevelSelector.getAllFollowedDids()
      ]);
      for (const did of secondLevelDids) {
        const follows = await fetchFollows(did);
        const followsToAdd = follows.map(p => p.did).filter(h => allDids.has(h));
        if (followsToAdd.length > 0) {
          followGraph.addFollows(did, followsToAdd);
        }
        this.status.fetched();
      }
    
      const actorRankCalculator = new ActorRankCalculator(0.8, 100);
      const ranks = actorRankCalculator.calculate(followGraph);
      const rankedActors: Array<RankedActor> = [];
      followGraph.dids.forEach((did, index) => {
        const profile = profiles.get(did);
        if (profile !== undefined) {
          rankedActors.push(new RankedActor(profile, ranks[index] ?? 0));
        }
      })
      this.status.changePhase(ActorRankingCreationPhase.Completed, 0);

      const excludedDids = new Set([params.yourDid]);
      if (!params.includeYourFollows) {
        const yourFollows = await this.followsFetcher.fetch(params.yourDid);
        yourFollows.forEach(p => excludedDids.add(p.did));
      }
      const result = rankedActors.sort((ra1, ra2) => Math.sign(ra2.rank - ra1.rank)).filter(ra => !excludedDids.has(ra.profile.did)).slice(0, params.limit);
      this.hydrateProfileDetails(result);
      return result;
    } catch(e) {
      this.status.changePhase(ActorRankingCreationPhase.Completed, 0);
      throw e;
    }
  }

  private async hydrateProfileDetails(result: Array<RankedActor>) {
    const profileDetails = await this.profileFetcher.fetch(result.map(ra => ra.profile.did));
    const profileDetailMap: Map<string, Profile> = new Map();
    profileDetails.forEach(p => profileDetailMap.set(p.did, p));
    result.forEach(ra => {
      const profileDetail = profileDetailMap.get(ra.profile.did);
      if (profileDetail !== undefined) {
        ra.profile = profileDetail;
      }
    });
  }
}

enum ActorRankingCreationPhase {
  SelectFirstLevelActors = "SelectFirstLevelActors",
  SelectSecondLevelActors = "SelectSecondLevelActors",
  FetchFollowsOfSecondLevelActors = "FetchFollowsOfSecondLevelActors",
  Completed = "Completed",
}

class ActorRankingCreationStatus {
  phase: ActorRankingCreationPhase = ActorRankingCreationPhase.SelectFirstLevelActors;
  completed: number = 0;
  total: number = 0;

  changePhase(phase: ActorRankingCreationPhase, total: number) {
    this.phase = phase;
    this.total = total;
    this.completed = 0;
  }

  fetched() {
    this.completed++;
  }

  getPercentage(): number {
    switch(this.phase) {
      case ActorRankingCreationPhase.SelectSecondLevelActors:
        return 50 * (Math.min(this.completed, this.total) / this.total);
      case ActorRankingCreationPhase.FetchFollowsOfSecondLevelActors:
        return 50 + 50 * (Math.min(this.completed, this.total) / this.total);
      case ActorRankingCreationPhase.Completed:
        return 100;
      default:
        return 0;
    }
  }
}

class MostFollowedActorsSelector {
  excludedDids: Set<string>;
  followCounts: Map<string, number> = new Map();
  actorFollows: Map<string, Array<string>> = new Map();

  constructor(excludedDids: Set<string>) {
    this.excludedDids = excludedDids;
  }

  addFollows(did: string, follows: Array<Profile>) {
    const filteredFollows: Array<Profile> = [];
    for (const profile of follows) {
      if (!this.excludedDids.has(profile.did)) {
        filteredFollows.push(profile);
        this.followCounts.set(profile.did, (this.followCounts.get(profile.did) ?? 0) + 1);
      }
    }
    const sortedDids = filteredFollows.sort((p1, p2) => (p2.followersCount ?? 0) - (p1.followersCount ?? 0)).map(p => p.did);
    this.actorFollows.set(did, sortedDids);
  }

  selectMostFollowedActors(limit: number): Array<string> {
    const allDids = Array.from(this.followCounts.keys());
    if (this.followCounts.size <= limit) {
      return allDids;
    }
    const actorFollowCounts: Array<[string, number]> = allDids.map(h => [h, this.followCounts.get(h) ?? 0]);
    actorFollowCounts.sort((e1, e2) => e2[1] - e1[1]);
    if (actorFollowCounts[limit-1][1] != actorFollowCounts[limit][1]) {
      return actorFollowCounts.slice(0, limit).map(t => t[0]);
    }
    const borderCount = actorFollowCounts[limit][1];
    const selectedDids = actorFollowCounts.filter(t => t[1] > borderCount).map(t => t[0]);
    const didsOnBorder = new Set(actorFollowCounts.filter(t => t[1] == borderCount).map(t => t[0]));
    const filteredActorFollows = Array.from(this.actorFollows.entries()).map(e => [e[0], e[1].filter(did => didsOnBorder.has(did))]);
    const selectedDidsOnBorder = new Set();
    let index = 0;
    while(selectedDids.length < limit) {
      for (const af of filteredActorFollows) {
        if (limit <= selectedDids.length) break;
        if (af[1].length <= index) continue;
        if (!selectedDidsOnBorder.has(af[1][index])) {
          selectedDids.push(af[1][index]);
          selectedDidsOnBorder.add(af[1][index]);
        }
      }
      index++;
    }
    return selectedDids;
  }

  getAllFollowedDids(): Array<string> {
    return Array.from(this.followCounts.keys())
  }
}

class FollowGraph {
  dids: Array<string> = [];
  didIndices: Map<string, number> = new Map();
  startDids: Array<string> = [];
  startIndices: Set<number> = new Set();
  follows: Array<Array<number>> = [];

  constructor(startDids: Array<string>) {
    this.dids = new Array();
    this.didIndices
    for (const startDid of startDids) {
      const index = this.addDid(startDid)
      this.startDids.push(startDid);
      this.startIndices.add(index);
    }
  }

  private addDid(did: string): number {
    const index = this.didIndices.get(did);
    if (index != undefined) {
      return index;
    } else {
      const newIndex = this.dids.length;
      this.dids.push(did);
      this.didIndices.set(did, newIndex);
      this.follows.push([]);
      return newIndex;
    }
  }

  addFollows(did: string, followedDids: Array<string>) {
    const index = this.addDid(did);
    for (const followedDid of followedDids) {
      const followedIndex = this.addDid(followedDid);
      this.follows[index].push(followedIndex);
    }
  }
}

class AdjacencyEdge {
  index: number;
  ratio: number;

  constructor(index: number, ratio: number) {
    this.index = index;
    this.ratio = ratio;
  }
} 

class ActorRankCalculator {
  dumpingFactor: number;
  iterationCount: number;

  constructor(dumpingFactor: number, iterationCount: number) {
    this.dumpingFactor = dumpingFactor;
    this.iterationCount = iterationCount;
  }

  calculate(followGraph: FollowGraph): Array<number> {
    const initialRanks = this.createInitialRanks(followGraph);
    const adjacencyMatrix = this.createAdjacencyMatrix(followGraph);
    let ranks = initialRanks;
    for (let i=0; i < this.iterationCount; i++) {
      ranks = this.calculateNextRanks(ranks, adjacencyMatrix, followGraph.startIndices);
    }
    return ranks;
  }

  private createInitialRanks(followGraph: FollowGraph): Array<number> {
    const rs = [];
    const startRank = 1.0 / followGraph.startDids.length;
    for (let i=0; i < followGraph.dids.length; i++) {
      if (followGraph.startIndices.has(i)) {
        rs.push(startRank);
      } else {
        rs.push(0.0);
      }
    }
    return rs; 
  }

  private createAdjacencyMatrix(followGraph: FollowGraph): Array<Array<AdjacencyEdge>> {
    const matrix: Array<Array<AdjacencyEdge>> = [];
    for (let i=0; i < followGraph.dids.length; i++) {
      matrix.push([]);
    }
    for (let i=0; i < followGraph.dids.length; i++) {
      const followedIndices = followGraph.follows[i];
      if (followedIndices.length == 0) continue;
      const ratio = 1.0 / followedIndices.length;
      for (const followedIndex of followedIndices) {
        matrix[followedIndex].push(new AdjacencyEdge(i, ratio));
      }
    }
    return matrix;
  }

  private calculateNextRanks(ranks: Array<number>, adjacencyMatrix: Array<Array<AdjacencyEdge>>, startIndices: Set<number>) {
    const nextRanks: Array<number> = [];
    for (let i=0; i < ranks.length; i++) {
      let rankByDumping = 0.0;
      if (startIndices.has(i)) {
        rankByDumping = (1.0 - this.dumpingFactor) / startIndices.size;
      }

      let rankByWalk = 0.0;
      for (const edge of adjacencyMatrix[i]) {
        rankByWalk += this.dumpingFactor * ranks[edge.index] * edge.ratio;
      }
      nextRanks.push(rankByDumping + rankByWalk);
    }
    const sum = nextRanks.reduce((a, b) => a+b, 0.0);
    return nextRanks.map(r => r/sum);
  }
}
