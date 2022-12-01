import { utils, ContractFactory, Contract } from 'ethers';
import chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import {
  abi as erc1056Abi,
  bytecode as erc1056Bytecode,
} from '@energyweb/onchain-claims/test/test_utils/ERC1056.json';
import { JsonRpcProvider, JsonRpcSigner } from '@ethersproject/providers';
import { OfferableIdentity__factory as OfferableIdentityFactory } from '@energyweb/credential-governance/ethers/factories/OfferableIdentity__factory';
import { RoleDefinitionResolverV2__factory } from '@energyweb/credential-governance/ethers/factories/RoleDefinitionResolverV2__factory';
import { DomainTransactionFactoryV2 } from '@energyweb/credential-governance/src';
import { ENSRegistry } from '@energyweb/credential-governance/ethers/ENSRegistry';
import { RoleDefinitionResolverV2 } from '@energyweb/credential-governance/ethers/RoleDefinitionResolverV2';
import { PreconditionType } from '@energyweb/credential-governance/src/types/domain-definitions';
import { defaultVersion } from '@energyweb/onchain-claims/test/test_utils/role-utils';
import { EwSigner, Operator } from '@ew-did-registry/did-ethr-resolver';
import { DidStore } from '@ew-did-registry/did-ipfs-store';
import { Methods, Chain } from '@ew-did-registry/did';
import {
  CredentialResolver,
  IssuerResolver,
  IpfsCredentialResolver,
  EthersProviderIssuerResolver,
  IRoleCredentialCache,
  IRoleDefinitionCache,
  RoleCredentialCache,
  RoleDefinitionCache,
} from '../src';
import { ClaimIssuerVerification } from '../src/verifier/claim-issuer-verification';
import {
  DIDAttribute,
  ProviderTypes,
  ProviderSettings,
  RegistrySettings,
  IUpdateData,
} from '@ew-did-registry/did-resolver-interface';
import { Keys } from '@ew-did-registry/keys';
import { JWT } from '@ew-did-registry/jwt';
import {
  spawnIpfsDaemon,
  shutDownIpfsDaemon,
} from '../../../test/utils/ipfs-daemon';
import {
  DomainReader,
  ResolverContractType,
  VOLTA_CHAIN_ID,
} from '@energyweb/credential-governance';
import { ChildProcess } from 'child_process';

chai.use(chaiAsPromised);
const expect = chai.expect;

const root = `0x${'0'.repeat(64)}`;
const adminRole = 'admin';
const userRole = 'user';
const activeuserRole = 'active-user';
const managerRole = 'manager';

const hashLabel = (label: string): string =>
  utils.keccak256(utils.toUtf8Bytes(label));

let roleFactory: DomainTransactionFactoryV2;
let roleResolver: RoleDefinitionResolverV2;
let registry: Contract;
let provider: JsonRpcProvider;
let issuerVerification: ClaimIssuerVerification;
let registrySettings: RegistrySettings;
let credentialResolver: CredentialResolver;
let issuerDefinitionResolver: IssuerResolver;
let roleCredentialCache: IRoleCredentialCache;
let roleDefCache: IRoleDefinitionCache;

let deployer: JsonRpcSigner;
let deployerAddr: string;
let user: EwSigner;
let userAddress: string;
let manager: EwSigner;
let managerAddress: string;
let admin: EwSigner;
let adminAddress: string;
let verifierAddress: string;

let userKeys: Keys;
let userDid: string;
let adminKeys: Keys;
let adminDid: string;
let managerKeys: Keys;
let managerDid: string;
let verifierKeys: Keys;

let userOperator: Operator;
let adminOperator: Operator;
let managerOperator: Operator;
let providerSettings: ProviderSettings;
let didStore: DidStore;
let ipfsUrl: string;

const validity = 10 * 60 * 1000;

export function claimIssuerVerificationTests(): void {
  let cluster: ChildProcess;

  before(async function () {
    ({ provider } = this);
    deployer = provider.getSigner(1);
    deployerAddr = await deployer.getAddress();

    providerSettings = {
      type: ProviderTypes.HTTP,
    };
    userKeys = new Keys({
      privateKey:
        '0dbbe8e4ae425a6d2687f1a7e3ba17bc98c673636790f1b8ad91193c05875ef1',
    });
    userAddress = userKeys.getAddress();
    userDid = `did:${Methods.Erc1056}:${Chain.VOLTA}:${userAddress}`;
    user = EwSigner.fromPrivateKey(userKeys.privateKey, providerSettings);

    adminKeys = new Keys({
      privateKey:
        '388c684f0ba1ef5017716adb5d21a053ea8e90277d0868337519f97bede61418',
    });
    adminAddress = adminKeys.getAddress();
    adminDid = `did:${Methods.Erc1056}:${Chain.VOLTA}:${adminAddress}`;
    admin = EwSigner.fromPrivateKey(adminKeys.privateKey, providerSettings);

    managerKeys = new Keys({
      privateKey:
        'aa3680d5d48a8283413f7a108367c7299ca73f553735860a87b08f39395618b7',
    });
    managerAddress = managerKeys.getAddress();
    managerDid = `did:${Methods.Erc1056}:${Chain.VOLTA}:${managerAddress}`;
    manager = EwSigner.fromPrivateKey(managerKeys.privateKey, providerSettings);

    verifierKeys = new Keys({
      privateKey:
        '8d5366123cb560bb606379f90a0bfd4769eecc0557f1b362dcae9012b548b1e5',
    });
    verifierAddress = verifierKeys.getAddress();
    ipfsUrl = await spawnIpfsDaemon();
  });

  after(async () => {
    await shutDownIpfsDaemon();
  });

  testSuite();
}

function testSuite() {
  beforeEach(async function () {
    const erc1056Factory = new ContractFactory(
      erc1056Abi,
      erc1056Bytecode,
      deployer
    );
    registry = await (await erc1056Factory.deploy()).deployed();

    const { ensFactory, domainNotifierFactory } = this;
    const ensRegistry: ENSRegistry = await (
      await ensFactory.connect(deployer).deploy()
    ).deployed();

    const notifier = await (
      await domainNotifierFactory.connect(deployer).deploy(ensRegistry.address)
    ).deployed();
    roleResolver = await (
      await new RoleDefinitionResolverV2__factory(deployer).deploy(
        ensRegistry.address,
        notifier.address
      )
    ).deployed();

    roleFactory = new DomainTransactionFactoryV2({
      domainResolverAddress: roleResolver.address,
    });

    registrySettings = {
      method: Methods.Erc1056,
      abi: erc1056Abi,
      address: registry.address,
    };

    providerSettings = {
      type: ProviderTypes.HTTP,
    };

    didStore = new DidStore(ipfsUrl);
    credentialResolver = new IpfsCredentialResolver(
      provider,
      registrySettings,
      didStore
    );
    userOperator = new Operator(user, { address: registry.address });
    adminOperator = new Operator(admin, { address: registry.address });
    managerOperator = new Operator(manager, { address: registry.address });

    await userOperator.create();
    await adminOperator.create();
    await managerOperator.create();
    const domainReader = new DomainReader({
      ensRegistryAddress: ensRegistry.address,
      provider: provider,
    });
    domainReader.addKnownResolver({
      chainId: VOLTA_CHAIN_ID,
      address: roleResolver.address,
      type: ResolverContractType.RoleDefinitionResolver_v2,
    });

    issuerDefinitionResolver = new EthersProviderIssuerResolver(domainReader);

    issuerVerification = new ClaimIssuerVerification(
      credentialResolver,
      issuerDefinitionResolver
    );
    roleCredentialCache = new RoleCredentialCache();
    roleDefCache = new RoleDefinitionCache();

    await (
      await ensRegistry.setSubnodeOwner(
        root,
        hashLabel(adminRole),
        deployerAddr
      )
    ).wait();
    await (
      await ensRegistry.setSubnodeOwner(root, hashLabel(userRole), deployerAddr)
    ).wait();
    await (
      await ensRegistry.setSubnodeOwner(
        root,
        hashLabel(activeuserRole),
        deployerAddr
      )
    ).wait();
    await (
      await ensRegistry.setSubnodeOwner(
        root,
        hashLabel(managerRole),
        deployerAddr
      )
    ).wait();

    await (
      await ensRegistry.setResolver(
        utils.namehash(adminRole),
        roleResolver.address
      )
    ).wait();
    await (
      await ensRegistry.setResolver(
        utils.namehash(userRole),
        roleResolver.address
      )
    ).wait();
    await (
      await ensRegistry.setResolver(
        utils.namehash(activeuserRole),
        roleResolver.address
      )
    ).wait();
    await (
      await ensRegistry.setResolver(
        utils.namehash(managerRole),
        roleResolver.address
      )
    ).wait();

    await (
      await deployer.sendTransaction({
        ...roleFactory.newRole({
          domain: adminRole,
          roleDefinition: {
            roleName: adminRole,
            enrolmentPreconditions: [],
            requestorFields: [],
            issuerFields: [],
            issuer: {
              issuerType: 'DID',
              did: [`did:ethr:volta:${await admin.getAddress()}`],
            },
            revoker: {
              revokerType: 'DID',
              did: [`did:ethr:volta:${await admin.getAddress()}`],
            },
            metadata: [],
            roleType: '',
            version: defaultVersion,
          },
        }),
      })
    ).wait();

    await (
      await deployer.sendTransaction({
        ...roleFactory.newRole({
          domain: userRole,
          roleDefinition: {
            roleName: userRole,
            enrolmentPreconditions: [],
            requestorFields: [],
            issuerFields: [],
            issuer: { issuerType: 'ROLE', roleName: managerRole },
            revoker: { revokerType: 'ROLE', roleName: managerRole },
            metadata: [],
            roleType: '',
            version: defaultVersion,
          },
        }),
      })
    ).wait();

    await (
      await deployer.sendTransaction({
        ...roleFactory.newRole({
          domain: activeuserRole,
          roleDefinition: {
            roleName: activeuserRole,
            enrolmentPreconditions: [
              { type: PreconditionType.Role, conditions: [userRole] },
            ],
            requestorFields: [],
            issuerFields: [],
            issuer: { issuerType: 'ROLE', roleName: managerRole },
            revoker: { revokerType: 'ROLE', roleName: managerRole },
            metadata: [],
            roleType: '',
            version: defaultVersion,
          },
        }),
      })
    ).wait();

    await (
      await deployer.sendTransaction({
        ...roleFactory.newRole({
          domain: managerRole,
          roleDefinition: {
            roleName: managerRole,
            enrolmentPreconditions: [],
            requestorFields: [],
            issuerFields: [],
            issuer: { issuerType: 'ROLE', roleName: adminRole },
            revoker: { revokerType: 'ROLE', roleName: adminRole },
            metadata: [],
            roleType: '',
            version: defaultVersion,
          },
        }),
      })
    ).wait();
  });

  describe('Issuance verification', () => {
    it('verifies issuer, where the role is issued by did', async () => {
      const adminJWT = new JWT(adminKeys);
      const claim = {
        claimData: { fields: {}, claimTypeVersion: 1, claimType: adminRole },
        iss: adminDid,
      };
      let token: string = '';
      let ipfsCID: string = 'ipfsUrl';
      if (admin.privateKey) {
        token = await adminJWT.sign(claim);
        if (token) {
          ipfsCID = await didStore.save(token);
        }
      }
      const serviceId = adminRole;
      const updateData: IUpdateData = {
        type: DIDAttribute.ServicePoint,
        value: {
          id: `${adminDid}#service-${serviceId}`,
          type: 'ClaimStore',
          serviceEndpoint: ipfsCID,
        },
      };
      await adminOperator.update(
        adminDid,
        DIDAttribute.ServicePoint,
        updateData,
        validity
      );

      expect(
        (
          await issuerVerification.verifyIssuer(
            adminDid,
            adminRole,
            roleCredentialCache,
            roleDefCache
          )
        ).verified
      ).true;
    });

    it('verifies issuer, where the role is issued by role', async () => {
      const adminJWT = new JWT(adminKeys);
      const claimAdmin = {
        claimData: { fields: {}, claimType: adminRole, claimTypeVersion: 1 },
        iss: adminDid,
        signer: adminDid,
      };
      let token: string = '';
      let ipfsCIDAdmin: string = 'ipfsUrl';
      if (admin.privateKey) {
        token = await adminJWT.sign(claimAdmin);
        if (token) {
          ipfsCIDAdmin = await didStore.save(token);
        }
      }
      const serviceIdAdmin = adminRole;
      const updateDataAdmin: IUpdateData = {
        type: DIDAttribute.ServicePoint,
        value: {
          id: `${adminDid}#service-${serviceIdAdmin}`,
          type: 'ClaimStore',
          serviceEndpoint: ipfsCIDAdmin,
        },
      };
      await adminOperator.update(
        adminDid,
        DIDAttribute.ServicePoint,
        updateDataAdmin,
        validity
      );

      const claimManager = {
        claimData: { fields: {}, claimTypeVersion: 1, claimType: managerRole },
        iss: adminDid,
        signer: adminDid,
      };
      let tokenManager: string = '';
      let ipfsCIDManager: string = 'ipfsUrl';
      if (admin.privateKey) {
        tokenManager = await adminJWT.sign(claimManager);
        if (tokenManager) {
          ipfsCIDManager = await didStore.save(tokenManager);
        }
      }
      const serviceIdManager = managerRole;
      const updateDataManager: IUpdateData = {
        type: DIDAttribute.ServicePoint,
        value: {
          id: `${managerDid}#service-${serviceIdManager}`,
          type: 'ClaimStore',
          serviceEndpoint: ipfsCIDManager,
        },
      };
      await managerOperator.update(
        managerDid,
        DIDAttribute.ServicePoint,
        updateDataManager,
        validity
      );

      expect(
        (
          await issuerVerification.verifyIssuer(
            adminDid,
            managerRole,
            roleCredentialCache,
            roleDefCache
          )
        ).verified
      ).true;
    });

    it('rejects credential for any unauthorised issuer in the chain', async () => {
      let adminJWT = new JWT(adminKeys);
      const claim = {
        claimData: { fields: {}, claimTypeVersion: 1, claimType: adminRole },
        iss: adminDid,
      };
      let token: string = '';
      let ipfsCIDAdmin: string = 'ipfsUrl';
      if (admin.privateKey) {
        token = await adminJWT.sign(claim);
        if (token) {
          ipfsCIDAdmin = await didStore.save(token);
        }
      }
      const serviceIdAdmin = adminRole;
      const updateDataAdmin: IUpdateData = {
        type: DIDAttribute.ServicePoint,
        value: {
          id: `${adminDid}#service-${serviceIdAdmin}`,
          type: 'ClaimStore',
          serviceEndpoint: ipfsCIDAdmin,
        },
      };
      await adminOperator.update(
        adminDid,
        DIDAttribute.ServicePoint,
        updateDataAdmin,
        validity
      );

      const claimsUser = {
        claimData: { fields: {}, claimTypeVersion: 1, claimType: userRole },
        iss: adminDid,
      };
      let tokenUser: string = '';
      let ipfsCIDUser: string = 'ipfsUrl';
      if (admin.privateKey) {
        tokenUser = await adminJWT.sign(claimsUser);
        if (token) {
          ipfsCIDUser = await didStore.save(token);
        }
      }
      const serviceIdUser = userRole;
      const updateDataUser: IUpdateData = {
        type: DIDAttribute.ServicePoint,
        value: {
          id: `${userDid}#service-${serviceIdUser}`,
          type: 'ClaimStore',
          serviceEndpoint: ipfsCIDUser,
        },
      };
      await userOperator.update(
        userDid,
        DIDAttribute.ServicePoint,
        updateDataUser,
        validity
      );
      const res = issuerVerification.verifyIssuer(
        adminDid,
        userRole,
        roleCredentialCache,
        roleDefCache
      );
      // `manager` claim required to issue `user` was not issued to `admin`
      await expect(res).to.be.rejectedWith(
        'Unable to resolve the issuer credential to verify their authority'
      );
    });
  });
}
