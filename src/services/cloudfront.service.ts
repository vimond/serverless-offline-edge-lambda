import {
	CloudFrontRequestEvent, CloudFrontResponseResult, Context
} from 'aws-lambda';

import { NoResult } from '../errors';
import { FunctionSet } from '../function-set';
import { combineResult, isResponseResult, toResultResponse } from '../utils';
import { CacheService } from './cache.service';
import { ServerlessInstance, ServerlessOptions } from '../types';
import { parse } from 'url';

export class CloudFrontLifecycle {

	private readonly log: (message: string) => void;

	constructor(
		private readonly serverless: ServerlessInstance,
		private options: ServerlessOptions,
		private event: CloudFrontRequestEvent,
		private context: Context,
		private fileService: CacheService,
		private fnSet: FunctionSet
	) {
		this.log = serverless.cli.log.bind(serverless.cli);
	}

	async run(url: string): Promise<CloudFrontResponseResult | void> {
		this.log(`Request for ${url}`);

		try {
			return await this.onViewerRequest();
		} catch (err) {
			if (!(err instanceof NoResult)) {
				throw err;
			}
		}

		try {
			return await this.onCache();
		} catch (err) {
			if (!(err instanceof NoResult)) {
				throw err;
			}
		}

		const result = await this.onOriginRequest();

		delete this.event.Records[0].cf.request.origin;

		await this.fileService.saveToCache(combineResult(this.event, result));

		return await this.onViewerResponse(result);
	}

	async onViewerRequest() {
		this.log('→ viewer-request');

		const result = await this.fnSet.viewerRequest(this.event, this.context);

		if (isResponseResult(result)) {
			return this.onViewerResponse(result);
		}

		throw new NoResult();
	}

	async onViewerResponse(result: CloudFrontResponseResult) {
		this.log('← viewer-response');

		const event = combineResult(this.event, result);
		return this.fnSet.viewerResponse(event, this.context);
	}

	async onCache() {
		this.log('→ cache');

		if (this.options.disableCache) {
			this.log('✗ Cache disabled');
			throw new NoResult();
		}

		const cached = this.fileService.retrieveFromCache(this.event);

		if (!cached) {
			this.log('✗ Cache miss');

			throw new NoResult();
		} else {
			this.log('✓ Cache hit');
		}

		const result = toResultResponse(cached);
		return this.onViewerResponse(result);
	}

	async onOrigin() {
		this.log('→ origin');
		return await this.fnSet.origin.retrieve(this.event);
	}

	async onOriginRequest() {
		this.log('→ origin-request');

		const { request } = this.event.Records[0].cf;

		if (this.fnSet.origin.customOrigin) {
			const { hostname, port, protocol } = parse(request.uri);
			const proto = protocol === 'https:' ? 'https' : 'http';
			const custom = { // TODO: Consider not filling all default options
				customHeaders: {},
				domainName: '',
				keepaliveTimeout: 5,
				path: '',
				port: Number(port),
				protocol: proto as 'http' | 'https',
				readTimeout: 30,
				sslProtocols: [
					'TLSv1',
					'TLSv1.1',
					'TLSv1.2'
				],
				...this.fnSet.origin.customOrigin,
			};
			if (!custom.domainName) {
				custom.domainName = hostname || '';
			}
			request.origin = {
				custom
			};
		}

		const result = await this.fnSet.originRequest(this.event, this.context);

		if (isResponseResult(result)) {
			return result;
		}

		const resultFromOrigin = await this.onOrigin();

		return this.onOriginResponse(resultFromOrigin);
	}

	async onOriginResponse(result: CloudFrontResponseResult) {
		this.log('← origin-response');

		const event = combineResult(this.event, result);
		return this.fnSet.originResponse(event, this.context);
	}
}
