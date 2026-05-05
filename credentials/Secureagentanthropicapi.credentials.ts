import { ICredentialType, INodeProperties } from 'n8n-workflow';

export class Secureagentanthropicapi implements ICredentialType {
	name = 'secureagentanthropicapi';
	displayName = 'Secure Agent — Anthropic API';
	documentationUrl = 'https://docs.anthropic.com/en/api/getting-started';
	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
		},
	];
}