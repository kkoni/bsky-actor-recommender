import cliProgress = require('cli-progress');
import { program } from 'commander';
import { BskyAgent } from '@atproto/api';
import { ProfileFetcher } from './lib/profile';
import { FollowsFetcher } from './lib/follows';
import { ActorRankingCreator, ActorRankingCreatorParameters } from './lib/actor_ranking';

program.name('bsky-user-recommender')
  .description('Shows a list of Bluesky actors relative to you or a specified group of actors.');
program.option(
  '-s, --start <string>',
   'A comma seperated list of at-identifiers. The command will recommend actors relevant to these actors.',
);
program.option(
  '-l, --limit <number>',
  'A max count of actors the command recommends.',
  '100'
);
program.option(
  '-m, --max-actors-per-level <number>',
  'A max count of actors for whom follow lists will be fetched. Larger number takes longer execution time and results in more persice result. (MAX=1000)',
  '100'
);
program.option(
  '-i, --include-your-follows',
  'Include actors you follow to the recommendation list.',
  false
);
program.option(
  '-v, --verbose',
  'Print detailed messages',
  false
);
program.parse();

function getParams(): ActorRankingCreatorParameters {
  const opts = program.opts()
  let startIdentifiers = opts.start?.split(',')?.filter((s: string) => !!s);
  if (startIdentifiers !== undefined && startIdentifiers.length === 0) {
    startIdentifiers = undefined;
  }
  let limit = opts.limit ? parseInt(opts.limit, 10) : 100;
  if (limit <= 0) {
    limit = 100;
  }
  let maxActorsPerLevel = opts.maxActorsPerLevel ? parseInt(opts.maxActorsPerLevel, 10) : 100;
  if (maxActorsPerLevel <= 0 || 1000 < maxActorsPerLevel) {
    maxActorsPerLevel = 100;
  }
  return new ActorRankingCreatorParameters("", startIdentifiers, limit, maxActorsPerLevel, opts.includeYourFollows, opts.verbose);
}

async function createBskyAgent(identifier: string, password: string): Promise<BskyAgent> {
  const agent = new BskyAgent({ service: 'https://bsky.social'});
  await agent.login({identifier: identifier, password: password});
  return agent;
}

async function run() {
  const params = getParams();
  require('dotenv').config();
  const bskyIdentifier = process.env.BSKY_IDENTIFIER;
  const bskyPassword = process.env.BSKY_PASSWORD;
  if (!bskyIdentifier) {
    console.error("Please set your Bluesky identifier to BSKY_IDENTIFIER environment variable");
    return 1;
  }
  if (!bskyPassword) {
    console.error("Please set your Bluesky password to BSKY_PASSWORD environment variable. It should not be your account password but an app password generated for this application.");
    return 2;
  }

  const bskyAgent = await createBskyAgent(bskyIdentifier, bskyPassword);
  if (!bskyAgent.session) {
    console.error("Can't find your identifier.");
    return 3;
  }
  params.yourDid = bskyAgent.session.did;
  if (!params.startIdentifiers) {
    params.startIdentifiers = [ bskyAgent.session.handle ];
  }

  const profileFetcher = new ProfileFetcher(bskyAgent);
  const followsFetcher = new FollowsFetcher(bskyAgent, 1000);
  const actorRankingCreator = new ActorRankingCreator(profileFetcher, followsFetcher);
  const result = actorRankingCreator.create(params);

  const progressBar = params.isVerbose ? undefined : new cliProgress.SingleBar({format: 'processing... {bar} | {percentage}%'}, cliProgress.Presets.shades_classic);
  try {
    progressBar?.start(100, 0);
    do {
      progressBar?.update(actorRankingCreator.getPercentage());
      await new Promise((res) => setTimeout(res, 1000));
    } while (!actorRankingCreator.isCompleted());
    progressBar?.update(100);
    progressBar?.stop();

    result.then(rankedActors => {
      console.log('handle : followers count')
      for (const rankedActor of rankedActors) {
        console.log(`${rankedActor.profile.handle} : ${rankedActor.profile.followersCount}`);
      }
    });
  } catch(e) {
    console.log(e);
    progressBar?.stop();
  }
}

run();
