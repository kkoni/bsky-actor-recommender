# bsky-actor-recommender

A recommendation tool for Bluesky actors.
It recommends actors by analyzing the follow graph.

## Requirements

Node.js 18 or higher

## Usage

Clone this repository and put .env file to the top directory with following contents.

```.env
BSKY_IDENTIFIER=<Your handle or DID>
BSKY_PASSWORD=<Your app password>
```

Then following command shows you a recommendation list.

```
$ npx ts-node cli.ts
```

Run with -h or --help option to see all available options.
