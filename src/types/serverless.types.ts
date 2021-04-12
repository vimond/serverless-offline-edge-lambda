
export interface ServerlessInstance {
	cli: {
		log(str: string): void
	};
	config: {
		servicePath: string
	};
	service: {
		custom: Record<string, any>;
		provider: {
			name: string
		}
		functions: { [key: string]: ServerlessFunction }
		package: ServerlessPackage
		getAllFunctions: () => string[]
	};
	pluginManager: PluginManager;
}

export interface ServerlessOptions {
	cacheDir: string;
	cloudfrontPort: number;
	disableCache: boolean;
	fileDir: string;
	port: number;
}

export interface EdgeLambdaOptions {
	distribution: string;
	eventType: | 'origin-request' | 'origin-response' | 'viewer-request' | 'viewer-response';
	pathPattern: string;
}

interface CloudFrontEventOptions {
	eventType: 'origin-request' | 'origin-response' | 'viewer-request' | 'viewer-response';
	pathPattern: string;
}

export interface ServerlessLambdaEvent {
	cloudFront: CloudFrontEventOptions;
}

export interface ServerlessFunction {
	handler: string;
	package: ServerlessPackage;
	lambdaAtEdge?: EdgeLambdaOptions;
	events: Array<ServerlessLambdaEvent>;
}

export interface ServerlessPackage {
	include: string[];
	exclude: string[];
	artifact?: string;
	individually?: boolean;
}

export interface PluginManager {
	spawn(command: string): Promise<void>;
}
