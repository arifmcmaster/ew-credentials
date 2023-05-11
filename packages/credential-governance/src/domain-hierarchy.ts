import { utils, providers, constants } from 'ethers';
import type { Result } from '@ethersproject/abi';
import type { EventFilter } from 'ethers';
import { ENSRegistry } from '../ethers/ENSRegistry';
import { ENSRegistry__factory } from '../ethers/factories/ENSRegistry__factory';
import { abi as ensRegistryContract } from '../build/contracts/ENS.json';
import { abi as ensResolverContract } from '../build/contracts/PublicResolver.json';
import { abi as domainNotifierContract } from '../build/contracts/DomainNotifier.json';
import { DomainReader } from './domain-reader';
import { PublicResolver__factory } from '../ethers/factories/PublicResolver__factory';
import { DomainNotifier__factory } from '../ethers/factories/DomainNotifier__factory';
import { PublicResolver } from '../ethers/PublicResolver';
import { DomainNotifier } from '../ethers/DomainNotifier';
import pMap from '@cjs-exporter/p-map';

const { namehash } = utils;
const { AddressZero } = constants;

export class DomainHierarchy {
  protected readonly _domainReader: DomainReader;
  protected readonly _ensRegistry: ENSRegistry;
  protected readonly _provider: providers.Provider;
  protected readonly _domainNotifier: DomainNotifier;
  protected readonly _publicResolver?: PublicResolver;

  constructor({
    domainReader,
    ensRegistryAddress,
    provider,
    domainNotifierAddress,
    publicResolverAddress,
  }: {
    domainReader: DomainReader;
    ensRegistryAddress: string;
    provider: providers.Provider;
    domainNotifierAddress: string;
    publicResolverAddress?: string;
  }) {
    if (!domainReader) throw new Error('You need to pass a DomainReader');
    this._domainReader = domainReader;
    if (!ensRegistryAddress)
      throw new Error(
        'You need to pass the address of ensRegistry ethers contract'
      );
    this._ensRegistry = ENSRegistry__factory.connect(
      ensRegistryAddress,
      provider
    );
    if (!provider) throw new Error('You need to pass a provider');
    this._provider = provider;
    if (!domainNotifierAddress)
      throw new Error(
        'You need to pass the address of a domain notifier contract'
      );
    this._domainNotifier = DomainNotifier__factory.connect(
      domainNotifierAddress,
      provider
    );

    if (publicResolverAddress) {
      this._publicResolver = PublicResolver__factory.connect(
        publicResolverAddress,
        provider
      );
    }
  }

  /**
   * Retrieves list of subdomains from on-chain for a given parent domain
   * based on the logs from the ENS resolver contracts.
   * By default, queries from the DomainNotifier contract.
   * If publicResolver available, also queries from PublicResolver contract.
   */
  public getSubdomainsUsingResolver = async ({
    domain,
    mode,
  }: {
    domain: string;
    mode: 'ALL' | 'FIRSTLEVEL';
  }): Promise<string[]> => {
    if (mode === 'ALL') {
      const getParser = (nameReader: (node: string) => Promise<string>) => {
        return async ({ node }: Result) => {
          try {
            const name = await nameReader(node);
            if (this.isMetadomain(name)) {
              return '';
            }

            if (name.endsWith(domain) && name !== domain) {
              const owner = await this._ensRegistry.owner(node);
              if (owner === AddressZero) return '';
              return name;
            }
          } catch {
            // A possible source of exceptions is if domain has been deleted (https://energyweb.atlassian.net/browse/SWTCH-997)
            return '';
          }
          return '';
        };
      };
      console.time('getDomainsFromLogs <DomainUpdated>');
      let subDomains = await this.getDomainsFromLogs({
        parser: getParser(this._domainReader.readName.bind(this._domainReader)),
        provider: this._domainNotifier.provider,
        event: this._domainNotifier.filters.DomainUpdated(null), // some updates may be missed because they require explicit notification
        contractInterface: new utils.Interface(domainNotifierContract),
      });
      console.timeEnd('getDomainsFromLogs <DomainUpdated>');
      if (this._publicResolver) {
        console.time('getDomainsFromLogs <TextChanged>');
        const publicResolverDomains = await this.getDomainsFromLogs({
          parser: getParser((node) => this._domainReader.readName(node)),
          provider: this._publicResolver.provider,
          event: this._publicResolver.filters.TextChanged(
            null,
            'metadata',
            null
          ),
          contractInterface: new utils.Interface(ensResolverContract),
        });
        subDomains = new Set([...publicResolverDomains, ...subDomains]);
      }
      console.timeEnd('getDomainsFromLogs <TextChanged>');
      return [...subDomains].filter(Boolean); // Boolean filter to remove empty string
    }
    console.time('getDomainsFromLogs <NewOwner first level>');
    const singleLevel = await this.getDomainsFromLogs({
      contractInterface: new utils.Interface(ensRegistryContract),
      event: this._ensRegistry.filters.NewOwner(namehash(domain), null, null),
      parser: async ({ node, label, owner }) => {
        if (owner === AddressZero) return '';
        const namehash = utils.keccak256(node + label.slice(2));
        try {
          const [name, ownerAddress] = await Promise.all([
            this._domainReader.readName(namehash),
            this._ensRegistry.owner(namehash),
          ]);
          if (ownerAddress === AddressZero) return '';
          if (this.isMetadomain(name)) {
            return '';
          }
          return name;
        } catch {
          return '';
        }
      },
      provider: this._ensRegistry.provider,
    });
    console.timeEnd('getDomainsFromLogs <NewOwner first level>');
    return [...singleLevel].filter(Boolean); // Boolean filter to remove empty string
  };

  /**
   * Retrieves list of subdomains from on-chain for a given parent domain
   * based on the ENS Registry contract logs.
   * For multi-level queries with many domains, querying the registry is slower than
   * using the resolver contract because each RPC call returns only direct subdomains
   */
  public getSubdomainsUsingRegistry = async ({
    domain,
  }: {
    domain: string;
  }): Promise<string[]> => {
    const parser = async ({ node, label, owner }: Result) => {
      try {
        if (owner === AddressZero) return '';
        const namehash = utils.keccak256(node + label.slice(2));
        const [name, ownerAddress] = await Promise.all([
          this._domainReader.readName(namehash),
          this._ensRegistry.owner(namehash),
        ]);
        if (ownerAddress === AddressZero) return '';
        return name;
      } catch {
        // A possible source of exceptions is if domain has been deleted (https://energyweb.atlassian.net/browse/SWTCH-997)
        return '';
      }
    };
    const subDomains: Set<string> = new Set();
    let parents = [domain];

    console.time('getDomainsFromLogs <NewOwner recursive>');
    // Breadth-first search down subdomain tree
    while (parents.length > 0) {
      const event = this._ensRegistry.filters.NewOwner(null, null, null);
      // topics should be able to accept an array: https://docs.ethers.io/v5/concepts/events/
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      event.topics[1] = parents.map(namehash);
      parents = [
        ...(await this.getDomainsFromLogs({
          provider: this._ensRegistry.provider,
          parser,
          event,
          contractInterface: new utils.Interface(ensRegistryContract),
        })),
      ];

      for (const p of parents) {
        if (!this.isMetadomain(p)) subDomains.add(p);
      }
    }
    console.timeEnd('getDomainsFromLogs <NewOwner recursive>');
    return [...subDomains].filter(Boolean);
  };

  private getDomainsFromLogs = async ({
    provider,
    parser,
    event,
    contractInterface,
  }: {
    provider: providers.Provider;
    parser: (log: Result) => Promise<string>;
    event: EventFilter;
    contractInterface: utils.Interface;
  }) => {
    console.group('getDomainsFromLogs');

    let mem = process.memoryUsage().heapUsed;
    let maxMem = mem;
    console.log(`max mem ${maxMem / 1e6} mb`);
    const filter = {
      fromBlock: 0,
      toBlock: 'latest',
      address: event.address,
      topics: event.topics || [],
    };
    mem = process.memoryUsage().heapUsed;
    if (mem > maxMem) {
      maxMem = mem;
      console.log(`max mem ${maxMem / 1e6} mb`);
    }

    console.time('domainReader.readName');
    const domains = await pMap(
      await provider.getLogs(filter),
      async (log) => {
        const parsedLog = contractInterface.parseLog(log);
        const decoded = contractInterface.decodeEventLog(
          parsedLog.name,
          log.data,
          log.topics
        );
        const parsed = await parser(decoded);

        mem = process.memoryUsage().heapUsed;
        if (mem > maxMem) {
          maxMem = mem;
          process.stdout.write(`max mem ${maxMem / 1e6} mb`);
          process.stdout.clearLine(0);
          process.stdout.cursorTo(0);
        }

        return parsed;
      },
      { concurrency: 3 }
    );
    process.stdout.write('\n');

    console.timeEnd('domainReader.readName');
    const nonEmptyDomains = domains.filter((domain) => domain != '');
    console.log(`> max memory ${maxMem / 1e6} mb`);
    console.groupEnd();
    return new Set(nonEmptyDomains);
  };

  private isMetadomain(name: string): boolean {
    return ['roles', 'apps', 'orgs'].some((meta) =>
      name.startsWith(`${meta}.`)
    );
  }
}
