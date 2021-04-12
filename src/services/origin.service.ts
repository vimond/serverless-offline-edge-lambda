import { CloudFrontHeaders, CloudFrontRequest, CloudFrontRequestEvent, CloudFrontResultResponse } from 'aws-lambda';
import * as Boom from 'boom';
import * as fs from 'fs-extra';
import * as http from 'http';
import * as https from 'https';
import * as path from 'path';

import { parse } from 'url';
import { toHttpHeaders } from '../utils';
import { OutgoingHttpHeaders } from 'http';

interface Headers {
	[key: string]: any;
}

interface Resource {
	headers: Headers;
	statusCode?: number;
	data: any; // In practice string | Buffer. Masks an issue with using CloudFrontResultResponse having body defined as string only.
}

const addHeader = (headersObject: CloudFrontHeaders, { key, value }: { key?: string, value?: any } = {}) => {
	if (key) {
		headersObject[key.toLowerCase()] = [{ key, value: value ? value.toString() : '' }];
	}
};

export class Origin {
	private readonly type: 'http' | 'https' | 'file' | 'noop' = 'http';
	public readonly customOrigin?: Record<string, any>;

	constructor(public readonly baseUrl: string = '', customOrigin?: Record<string, any>) {
		if (!baseUrl) {
			this.type = 'noop';
		} else if (/^http:\/\//.test(baseUrl)) {
			this.type = 'http';
		}  else if (/^https:\/\//.test(baseUrl)) {
			this.type = 'https';
		} else {
			this.baseUrl = path.resolve(baseUrl);
			this.type = 'file';
		}
		this.customOrigin = customOrigin;
		if (this.customOrigin) {
			const { hostname, protocol, port } = parse(this.baseUrl);
			if (!this.customOrigin.domainName) {
				this.customOrigin.domainName = hostname;
			}
			if (!this.customOrigin.protocol && protocol) {
				this.customOrigin.protocol = protocol.substr(0, protocol.length - 1);
			}
			if (!this.customOrigin.port) {
				this.customOrigin.port = port;
			}
		}
	}

	async retrieve(event: CloudFrontRequestEvent): Promise<CloudFrontResultResponse> {
		const { request } = event.Records[0].cf;

		try {
			const { data, headers: responseHeaders, statusCode = 0 } = await this.getResource(request);

			const headers = {} as CloudFrontHeaders;

			Object.entries(responseHeaders).forEach(([key, value]) => addHeader(headers, { key, value }));

			return {
				status: statusCode.toString(),
				statusDescription: '',
				headers,
				bodyEncoding: 'text',
				body: data
			};
		} catch (err) {
			if (err instanceof Boom.notFound) {
				return {
					status: '404'
				};
			} else {
				return {
					status: '500',
					statusDescription: err.message
				};
			}
		}
	}

	async getResource(request: CloudFrontRequest): Promise<Resource> {
		const { uri: key } = request;

		switch (this.type) {
			case 'file': {
				return this.getFileResource(key);
			}
			case 'http':
			case 'https': {
				return this.getHttpResource(request);
			}
			case 'noop': {
				throw Boom.notFound();
			}
			default: {
				throw Boom.internal('Invalid origin type');
			}
		}
	}

	private async getFileResource(key: string): Promise<Resource> {
		const uri = parse(key);
		const fileName = uri.pathname;

		const fileContent = await fs.readFile(`${this.baseUrl}/${fileName}`, 'utf-8');
		return {
			headers: {},
			data: fileContent,
		};
	}

	private async getHttpResource(request: CloudFrontRequest): Promise<Resource> {
		const uri = parse(request.uri);
		const baseUrl = parse(this.baseUrl);

		const headers = toHttpHeaders(request.headers).reduce((acc, item) => {
			acc[item.key] = item.value[0];
			return acc;
		}, {} as OutgoingHttpHeaders);

		let options: http.RequestOptions;
		if (request.origin && request.origin.custom) {
			const { custom } = request.origin;
			options = {
				method: request.method,
				protocol: custom.protocol + ':',
				hostname: custom.domainName,
				port: custom.port || (custom.protocol === 'https' ? 443 : 80),
				path: uri.path,
				headers: {
					...headers,
					...custom.customHeaders,
					connection: 'Close'
				}
			};
		} else {
			options = {
				method: request.method,
				protocol: baseUrl.protocol,
				hostname: baseUrl.hostname,
				port: baseUrl.port || (baseUrl.protocol === 'https:' ? 443 : 80),
				path: uri.path,
				headers: {
					...headers,
					connection: 'Close'
				}
			};
		}

		const isHttps = (options.protocol || this.type).startsWith('https');
		const httpModule = isHttps ? https : http;

		return new Promise((resolve, reject) => {
			const req = httpModule.request(options, (res: http.IncomingMessage) => {
				const chunks: Uint8Array[] = [];

				res.on('data', (chunk: Uint8Array) => {
					chunks.push(chunk);
				});

				res.on('close', () => {
					resolve({
						headers: res.headers,
						statusCode: res.statusCode,
						data: Buffer.concat(chunks),
					});
				});
				res.on('error', (err: Error) => reject(err));
			});

			req.end();
		});
	}
}
