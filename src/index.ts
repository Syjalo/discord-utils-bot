import polka, { Middleware, NextHandler, Request, Response } from 'polka';
import {
	logger,
	jsonParser,
	prepareAck,
	prepareErrorResponse,
	prepareResponse,
	API_BASE_MDN,
	ArgumentsOf,
	EMOJI_ID_CLYDE_BLURPLE,
	EMOJI_ID_GUIDE,
	PREFIX_BUG,
	PREFIX_TEAPOT,
	transformInteraction,
} from './util';
import { djsDocs } from './functions/docs';
import { mdnSearch } from './functions/mdn';
import { nodeSearch } from './functions/node';
import { loadTags, reloadTags, showTag, Tag } from './functions/tag';
import Collection from '@discordjs/collection';
import { Doc } from 'discordjs-docs-parser';
import { InteractionType, APIInteraction, ApplicationCommandType } from 'discord-api-types/v10';
import { DiscordDocsCommand } from './interactions/discorddocs';
import { GuideCommand } from './interactions/guide';
import { MdnCommand } from './interactions/mdn';
import { NodeCommand } from './interactions/node';
import { TagCommand } from './interactions/tag';
import { TagReloadCommand } from './interactions/tagreload';
import { tagAutoComplete } from './functions/autocomplete/tagAutoComplete';
import { resolveOptionsToDocsAutoComplete, djsDocsAutoComplete } from './functions/autocomplete/docsAutoComplete';
import { mdnAutoComplete } from './functions/autocomplete/mdnAutoComplete';
import { algoliaAutoComplete } from './functions/autocomplete/algoliaAutoComplete';
import { algoliaResponse } from './functions/algoliaResponse';
import { webcrypto } from 'node:crypto';

// @ts-expect-error
const { subtle } = webcrypto;

const encoder = new TextEncoder();

function hex2bin(hex: string) {
	const buf = new Uint8Array(Math.ceil(hex.length / 2));
	for (let i = 0; i < buf.length; i++) {
		buf[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	}
	return buf;
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
const PUBKEY = subtle.importKey(
	'raw',
	hex2bin(process.env.DISCORD_PUBKEY!),
	{
		name: 'NODE-ED25519',
		namedCurve: 'NODE-ED25519',
		public: true,
	},
	true,
	['verify'],
);

async function verify(req: Request, res: Response, next: NextHandler) {
	if (!req.headers['x-signature-ed25519']) {
		res.writeHead(401);
		return res.end();
	}
	const signature = req.headers['x-signature-ed25519'] as string;
	const timestamp = req.headers['x-signature-timestamp'] as string;

	if (!signature || !timestamp) {
		res.writeHead(401);
		return res.end();
	}

	const hexSignature = hex2bin(signature);

	// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
	const isValid = await subtle.verify(
		'NODE-ED25519',
		await PUBKEY,
		hexSignature,
		encoder.encode(timestamp + req.rawBody),
	);

	if (!isValid) {
		res.statusCode = 401;
		return res.end();
	}
	void next();
}

type CommandName = 'discorddocs' | 'docs' | 'guide' | 'invite' | 'mdn' | 'node' | 'tag' | 'tagreload';
type CommandAutoCompleteName = 'docs' | 'tag' | 'mdn' | 'guide' | 'discorddocs';

export interface MDNIndexEntry {
	title: string;
	url: string;
}

const tagCache: Collection<string, Tag> = new Collection();
const mdnIndexCache: MDNIndexEntry[] = [];
void loadTags(tagCache);
logger.info(`Tag cache loaded with ${tagCache.size} entries.`);

// Set built in escape markdown links to true
Doc.setGlobalOptions({
	escapeMarkdownLinks: true,
});

export async function start() {
	const mdnData = (await fetch(`${API_BASE_MDN}/en-US/search-index.json`)
		.then((r) => r.json())
		.catch(() => undefined)) as MDNIndexEntry[] | undefined;
	if (mdnData) {
		const mdnResult = mdnData;
		mdnIndexCache.push(...mdnResult.map((r) => ({ title: r.title, url: `${r.url}` })));
	}

	polka()
		.use(jsonParser(), verify as Middleware)
		.post('/interactions', async (req, res) => {
			try {
				const message = req.body as APIInteraction;
				if (message.type === InteractionType.Ping) {
					prepareAck(res);
					res.end();
					return;
				}
				if (message.type === InteractionType.ApplicationCommand) {
					const data = message.data;
					if (data.type === ApplicationCommandType.ChatInput) {
						const options = data.options ?? [];
						const name = data.name as CommandName;
						const args = transformInteraction(options);

						switch (name) {
							case 'discorddocs': {
								const castArgs = args as ArgumentsOf<typeof DiscordDocsCommand>;
								await algoliaResponse(
									res,
									process.env.DDOCS_ALGOLIA_APP!,
									process.env.DDOCS_ALOGLIA_KEY!,
									'discord',
									castArgs.query,
									EMOJI_ID_CLYDE_BLURPLE,
									castArgs.target,
								);
								break;
							}

							case 'docs': {
								const resolved = resolveOptionsToDocsAutoComplete(options);
								if (!resolved) {
									prepareErrorResponse(res, `Payload looks different than expected`);
									break;
								}

								const { source, query, target } = resolved;
								const doc = await Doc.fetch(source, { force: true });
								(await djsDocs(res, doc, source, query, target)).end();
								break;
							}

							case 'guide': {
								const castArgs = args as ArgumentsOf<typeof GuideCommand>;
								await algoliaResponse(
									res,
									process.env.DJS_GUIDE_ALGOLIA_APP!,
									process.env.DJS_GUIDE_ALGOLIA_KEY!,
									'discordjs',
									castArgs.query,
									EMOJI_ID_GUIDE,
									castArgs.target,
								);
								break;
							}
							case 'invite': {
								prepareResponse(
									res,
									`Add the discord.js interaction to your server: [(click here)](<https://discord.com/api/oauth2/authorize?client_id=${process
										.env.DISCORD_CLIENT_ID!}&scope=applications.commands>)`,
									true,
								);
								break;
							}
							case 'mdn': {
								const castArgs = args as ArgumentsOf<typeof MdnCommand>;
								await mdnSearch(res, castArgs.query, castArgs.target);
								break;
							}
							case 'node': {
								const castArgs = args as ArgumentsOf<typeof NodeCommand>;
								await nodeSearch(res, castArgs.query, castArgs.version, castArgs.target);
								break;
							}
							case 'tag': {
								const castArgs = args as ArgumentsOf<typeof TagCommand>;
								await showTag(res, castArgs.query, tagCache, castArgs.target);
								break;
							}
							case 'tagreload': {
								const castArgs = args as ArgumentsOf<typeof TagReloadCommand>;
								await reloadTags(res, tagCache, castArgs.remote ?? false);
								break;
							}
						}
					}
				} else if (message.type === InteractionType.ApplicationCommandAutocomplete) {
					const data = message.data;
					const name = data.name as CommandAutoCompleteName;
					switch (name) {
						case 'docs': {
							await djsDocsAutoComplete(res, data.options);
							break;
						}
						case 'tag': {
							await tagAutoComplete(res, data.options, tagCache);
							break;
						}
						case 'guide': {
							const args = transformInteraction<typeof GuideCommand>(data.options);
							await algoliaAutoComplete(
								res,
								args.query,
								process.env.DJS_GUIDE_ALGOLIA_APP!,
								process.env.DJS_GUIDE_ALGOLIA_KEY!,
								'discordjs',
							);
							break;
						}
						case 'discorddocs': {
							const args = transformInteraction<typeof GuideCommand>(data.options);
							await algoliaAutoComplete(
								res,
								args.query,
								process.env.DDOCS_ALGOLIA_APP!,
								process.env.DDOCS_ALOGLIA_KEY!,
								'discord',
							);
							break;
						}
						case 'mdn': {
							await mdnAutoComplete(res, data.options, mdnIndexCache);
							break;
						}
					}
				} else {
					logger.warn(`Received interaction of type ${message.type}`);
					prepareResponse(res, `${PREFIX_BUG} This shouldn't be there...`, true);
				}

				res.end();
			} catch (error) {
				logger.error(error as Error);
				prepareResponse(res, `${PREFIX_TEAPOT} Looks like something went wrong here, please try again later!`, true);
			}
		})
		.listen(parseInt(process.env.PORT!, 10));
	logger.info(`Listening for interactions on port ${parseInt(process.env.PORT!, 10)}`);
}

void start();
