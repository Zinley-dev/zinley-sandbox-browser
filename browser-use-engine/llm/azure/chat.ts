/**
 * Azure OpenAI chat model
 * Port from browser_use/llm/azure/chat.py (92 lines)
 *
 * This uses the Azure OpenAI Service which is a wrapper around OpenAI's API
 * with Azure-specific authentication and endpoints.
 */

import { AzureOpenAI } from 'openai';
import { z } from 'zod';
import { BaseChatModel } from '../base.js';
import { BaseMessage } from '../messages.js';
import { ChatInvokeCompletion } from '../views.js';
import { ModelProviderError } from '../exceptions.js';

export interface ChatAzureOpenAIOptions {
	model: string;
	apiKey?: string;
	apiVersion?: string;
	azureEndpoint?: string;
	azureDeployment?: string;
	azureAdToken?: string;
	azureAdTokenProvider?: () => Promise<string>;
	temperature?: number;
	topP?: number;
	frequencyPenalty?: number;
	presencePenalty?: number;
	maxTokens?: number;
	organization?: string;
	defaultHeaders?: Record<string, string>;
	defaultQuery?: Record<string, any>;
}

export class ChatAzureOpenAI implements BaseChatModel {
	model: string;
	private client: AzureOpenAI;
	private temperature: number;
	private topP?: number;
	private frequencyPenalty: number;
	private presencePenalty: number;
	private maxTokens?: number;
	private organization?: string;
	private apiVersion: string;
	private azureEndpoint?: string;
	private azureDeployment?: string;

	constructor(options: ChatAzureOpenAIOptions) {
		this.model = options.model;
		this.temperature = options.temperature ?? 0.7;
		this.topP = options.topP;
		this.frequencyPenalty = options.frequencyPenalty ?? 0;
		this.presencePenalty = options.presencePenalty ?? 0;
		this.maxTokens = options.maxTokens;
		this.organization = options.organization;
		this.apiVersion = options.apiVersion || process.env.AZURE_OPENAI_API_VERSION || '2024-12-01-preview';
		this.azureEndpoint = options.azureEndpoint || process.env.AZURE_OPENAI_ENDPOINT;
		this.azureDeployment = options.azureDeployment || process.env.AZURE_OPENAI_DEPLOYMENT;

		const apiKey = options.apiKey || process.env.AZURE_OPENAI_KEY || process.env.AZURE_OPENAI_API_KEY;

		const clientParams: any = {
			apiKey,
			apiVersion: this.apiVersion,
			endpoint: this.azureEndpoint,
			deployment: this.azureDeployment,
		};

		if (options.azureAdToken) {
			clientParams.azureADToken = options.azureAdToken;
		}

		if (options.azureAdTokenProvider) {
			clientParams.azureADTokenProvider = options.azureAdTokenProvider;
		}

		if (this.organization) {
			clientParams.organization = this.organization;
		}

		if (options.defaultHeaders) {
			clientParams.defaultHeaders = options.defaultHeaders;
		}

		if (options.defaultQuery) {
			clientParams.defaultQuery = options.defaultQuery;
		}

		this.client = new AzureOpenAI(clientParams);
	}

	get provider(): string {
		return 'azure';
	}

	get name(): string {
		return this.model;
	}

	async ainvoke<T extends z.ZodType>(
		messages: BaseMessage[],
		outputFormat?: T
	): Promise<ChatInvokeCompletion<T extends z.ZodType ? z.infer<T> : string>> {
		// Azure uses the same API as OpenAI, so we can reuse the same logic
		// For now, just throw an error directing to use ChatOpenAI with Azure endpoint
		throw new ModelProviderError({
			message: 'Azure OpenAI implementation pending. Use ChatOpenAI with Azure baseURL for now.',
			statusCode: 501,
			model: this.model,
		});
	}
}

