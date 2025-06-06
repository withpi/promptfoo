import chalk from 'chalk';
import { getEnvString } from '../envars';
import { fetchWithProxy } from '../fetch';
import logger from '../logger';
import { readGlobalConfig, writeGlobalConfigPartial } from './globalConfig';

export const API_HOST = getEnvString('API_HOST', 'https://api.promptfoo.app');

interface CloudUser {
  id: string;
  name: string;
  email: string;
  createdAt: Date;
  updatedAt: Date;
}

interface CloudOrganization {
  id: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
}

interface CloudApp {
  url: string;
}

export class CloudConfig {
  private config: {
    appUrl: string;
    apiHost: string;
    apiKey?: string;
  };

  constructor() {
    const savedConfig = readGlobalConfig()?.cloud || {};
    this.config = {
      appUrl: savedConfig.appUrl || 'https://www.promptfoo.app',
      apiHost: savedConfig.apiHost || API_HOST,
      apiKey: savedConfig.apiKey,
    };
  }

  isEnabled(): boolean {
    return !!this.config.apiKey;
  }

  setApiHost(apiHost: string): void {
    this.config.apiHost = apiHost;
    this.saveConfig();
  }

  setApiKey(apiKey: string): void {
    this.config.apiKey = apiKey;
    this.saveConfig();
  }

  getApiKey(): string | undefined {
    return this.config.apiKey;
  }

  getApiHost(): string {
    return this.config.apiHost;
  }

  setAppUrl(appUrl: string): void {
    this.config.appUrl = appUrl;
    this.saveConfig();
  }

  getAppUrl(): string {
    return this.config.appUrl;
  }

  delete(): void {
    writeGlobalConfigPartial({ cloud: {} });
  }

  private saveConfig(): void {
    writeGlobalConfigPartial({ cloud: this.config });
    this.reload();
  }

  private reload(): void {
    const savedConfig = readGlobalConfig()?.cloud || {};
    this.config = {
      appUrl: savedConfig.appUrl || 'https://www.promptfoo.app',
      apiHost: savedConfig.apiHost || API_HOST,
      apiKey: savedConfig.apiKey,
    };
  }

  async validateAndSetApiToken(
    token: string,
    apiHost: string,
  ): Promise<{ user: CloudUser; organization: CloudOrganization; app: CloudApp }> {
    const response = await fetchWithProxy(`${apiHost}/users/me`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      throw new Error('Failed to validate API token: ' + response.statusText);
    }

    const { user, organization, app } = await response.json();
    this.setApiKey(token);
    this.setApiHost(apiHost);
    this.setAppUrl(app.url);

    logger.info(chalk.green.bold('Successfully logged in'));
    logger.info(chalk.dim('Logged in as:'));
    logger.info(`User: ${chalk.cyan(user.email)}`);
    logger.info(`Organization: ${chalk.cyan(organization.name)}`);
    logger.info(`Access the app at ${chalk.cyan(app.url)}`);

    return {
      user,
      organization,
      app,
    };
  }
}

// singleton instance
export const cloudConfig = new CloudConfig();
