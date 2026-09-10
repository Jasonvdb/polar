import { join } from 'path';
import { PaykitEnvironment } from 'shared/paykitApi';
import { paykitConfig } from 'shared/paykitConfig';
import { getProjectName, getNamespacedContainerName } from 'shared/paykitConfig';
import {
  BitcoinNode,
  CLightningNode,
  CommonNode,
  EclairNode,
  LitdNode,
  LndNode,
  TapdNode,
} from 'shared/types';
import {
  bitcoinCredentials,
  dockerConfigs,
  eclairCredentials,
  litdCredentials,
} from 'utils/constants';
import { getContainerName, getDefaultCommand } from 'utils/network';
import { isWindows } from 'utils/system';
import { bitcoind, clightning, eclair, litd, lnd, simln, tapd } from './nodeTemplates';

export interface ComposeService {
  image: string;
  container_name: string;
  environment?: Record<string, string>;
  hostname: string;
  command: string;
  volumes: string[];
  expose: string[];
  ports: string[];
  restart?: 'always';
  depends_on?: Record<string, { condition: string }>;
  healthcheck?: { test: string[]; interval: string; timeout: string; retries: number };
  init?: boolean;
  user?: string;
  stop_grace_period?: string;
}

export interface ComposeContent {
  name: string;
  services: {
    [key: string]: ComposeService;
  };
  volumes?: {
    [key: string]: { name: string } | null;
  };
}

class ComposeFile {
  content: ComposeContent;

  constructor(id: number) {
    this.content = {
      name: getProjectName(id),
      services: {},
    };
  }

  addService(service: ComposeService) {
    this.content.services[service.hostname] = {
      environment: {
        USERID: '${USERID:-1000}',
        GROUPID: '${GROUPID:-1000}',
        ...service.environment,
      },
      stop_grace_period: '30s',
      ...service,
    };
  }

  addBitcoind(node: BitcoinNode) {
    const { name, version, ports } = node;
    const { rpc, p2p, zmqBlock, zmqTx } = ports;
    const container = getContainerName(node);
    // define the variable substitutions
    const variables = {
      rpcUser: bitcoinCredentials.user,
      rpcAuth: bitcoinCredentials.rpcauth,
    };
    // use the node's custom image or the default for the implementation
    const image = node.docker.image || `${dockerConfigs.bitcoind.imageName}:${version}`;
    // use the node's custom command or the default for the implementation
    const nodeCommand = node.docker.command || getDefaultCommand('bitcoind', version);
    // replace the variables in the command
    const command = this.mergeCommand(nodeCommand, variables);
    // add the docker service
    const svc = bitcoind(name, container, image, rpc, p2p, zmqBlock, zmqTx, command);
    this.addService(svc);
  }

  addLnd(node: LndNode, backend: CommonNode) {
    const { name, version, ports } = node;
    const { rest, grpc, p2p } = ports;
    const container = getContainerName(node);
    // define the variable substitutions
    const variables = {
      name: node.name,
      containerName: container,
      backendName: getContainerName(backend),
      rpcUser: bitcoinCredentials.user,
      rpcPass: bitcoinCredentials.pass,
    };
    // use the node's custom image or the default for the implementation
    const image = node.docker.image || `${dockerConfigs.LND.imageName}:${version}`;
    // use the node's custom command or the default for the implementation
    const nodeCommand = node.docker.command || getDefaultCommand('LND', version);
    // replace the variables in the command
    const command = this.mergeCommand(nodeCommand, variables);
    // add the docker service
    const svc = lnd(name, container, image, rest, grpc, p2p, command);
    this.addService(svc);
  }

  addClightning(node: CLightningNode, backend: CommonNode) {
    const { name, version, ports } = node;
    const { rest, p2p, grpc } = ports;
    const container = getContainerName(node);
    // define the variable substitutions
    const variables = {
      name: node.name,
      backendName: getContainerName(backend),
      rpcUser: bitcoinCredentials.user,
      rpcPass: bitcoinCredentials.pass,
    };
    // use the node's custom image or the default for the implementation
    const image =
      node.docker.image || `${dockerConfigs['c-lightning'].imageName}:${version}`;
    // use the node's custom command or the default for the implementation
    let nodeCommand = node.docker.command || getDefaultCommand('c-lightning', version);
    // do not include the GRPC port arg in the command for unsupported versions
    if (grpc === 0) nodeCommand = nodeCommand.replace('--grpc-port=11001', '');
    // replace the variables in the command
    const command = this.mergeCommand(nodeCommand, variables);
    // On Windows, use a named Docker volume for CLN's data directory instead of a bind mount.
    let namedVolumeName: string | undefined;
    if (isWindows()) {
      namedVolumeName = container;
      // register the named volume in the top-level volumes declaration
      if (!this.content.volumes) {
        this.content.volumes = {};
      }
      this.content.volumes[namedVolumeName] = null;
    }
    // add the docker service
    const svc = clightning(
      name,
      container,
      image,
      rest,
      grpc,
      p2p,
      command,
      namedVolumeName,
    );
    this.addService(svc);
  }

  addEclair(node: EclairNode, backend: CommonNode) {
    const { name, version, ports } = node;
    const { rest, p2p } = ports;
    const container = getContainerName(node);
    // define the variable substitutions
    const variables = {
      name: node.name,
      backendName: getContainerName(backend),
      eclairPass: eclairCredentials.pass,
      rpcUser: bitcoinCredentials.user,
      rpcPass: bitcoinCredentials.pass,
    };
    // use the node's custom image or the default for the implementation
    const image = node.docker.image || `${dockerConfigs.eclair.imageName}:${version}`;
    // use the node's custom command or the default for the implementation
    const nodeCommand = node.docker.command || getDefaultCommand('eclair', version);
    // replace the variables in the command
    const command = this.mergeCommand(nodeCommand, variables);
    // add the docker service
    const svc = eclair(name, container, image, rest, p2p, command);
    this.addService(svc);
  }

  addLitd(node: LitdNode, backend: CommonNode, proofCourier: CommonNode) {
    const { name, version, ports } = node;
    const { rest, grpc, p2p, web } = ports;
    const container = getContainerName(node);
    // define the variable substitutions
    const variables = {
      name: node.name,
      containerName: container,
      backendName: getContainerName(backend),
      rpcUser: bitcoinCredentials.user,
      rpcPass: bitcoinCredentials.pass,
      litdPass: litdCredentials.pass,
      proofCourier: getContainerName(proofCourier),
    };
    // use the node's custom image or the default for the implementation
    const image = node.docker.image || `${dockerConfigs.litd.imageName}:${version}`;
    // use the node's custom command or the default for the implementation
    const nodeCommand = node.docker.command || getDefaultCommand('litd', version);
    // replace the variables in the command
    const command = this.mergeCommand(nodeCommand, variables);
    // add the docker service
    const svc = litd(name, container, image, rest, grpc, p2p, web, command);
    this.addService(svc);
  }

  addTapd(node: TapdNode, lndBackend: LndNode) {
    const { name, version, ports } = node;
    const { rest, grpc } = ports;
    const container = getContainerName(node);
    // define the variable substitutions
    const variables = {
      name: node.name,
      containerName: container,
      lndName: getContainerName(lndBackend),
    };
    // use the node's custom image or the default for the implementation
    const image = node.docker.image || `${dockerConfigs.tapd.imageName}:${version}`;
    // use the node's custom command or the default for the implementation
    const nodeCommand = node.docker.command || getDefaultCommand('tapd', version);
    // replace the variables in the command
    const command = this.mergeCommand(nodeCommand, variables);
    // add the docker service
    const svc = tapd(name, container, image, rest, grpc, lndBackend.name, command);
    this.addService(svc);
  }

  addSimln(networkId: number) {
    const { name, imageName, command, env } = dockerConfigs.simln;
    const containerName = getNamespacedContainerName(networkId, 'simln');
    const svc = simln(name, containerName, imageName, command, { ...env });
    this.addService(svc);
  }

  addPaykit(networkId: number, environment: PaykitEnvironment) {
    if (this.content.services.paykit || this.content.services['paykit-postgres']) {
      throw new Error(
        'Node names paykit and paykit-postgres are reserved for Paykit services',
      );
    }
    const secrets = join(
      paykitConfig.dataPath,
      'paykit-credentials',
      environment.environmentId,
    ).replace(/\\/g, '/');
    this.addService({
      image:
        'postgres:18-bookworm@sha256:1c59e2c3c818eaa0f0628f695b36e7c9e362d6b219b36a54a32df645cbd7e1af',
      hostname: 'paykit-postgres',
      user: '${PAYKIT_UID:-1000}:${PAYKIT_GID:-1000}',
      container_name: getNamespacedContainerName(networkId, 'paykit-postgres'),
      command: 'postgres',
      ports: [],
      expose: [],
      environment: {
        POSTGRES_USER: 'pubky',
        POSTGRES_DB: 'pubky',
        POSTGRES_PASSWORD_FILE: '/run/paykit/postgres-password',
        PGDATA: '/var/lib/postgresql/18/docker',
      },
      volumes: [
        './volumes/paykit-postgres:/var/lib/postgresql',
        `${secrets}/postgres-password:/run/paykit/postgres-password:ro`,
      ],
      healthcheck: {
        test: ['CMD-SHELL', 'pg_isready -U pubky -d pubky'],
        interval: '2s',
        timeout: '3s',
        retries: 30,
      },
    });
    this.addService({
      image: 'polar-paykit/service:pr2',
      hostname: 'paykit',
      user: '${PAYKIT_UID:-1000}:${PAYKIT_GID:-1000}',
      container_name: getNamespacedContainerName(networkId, 'paykit'),
      command: 'serve',
      init: true,
      ports: [`127.0.0.1:${environment.servicePort}:10090`],
      expose: [],
      environment: {
        PAYKIT_ENVIRONMENT_ID: environment.environmentId,
        PAYKIT_DATA_DIR: '/data',
        PAYKIT_KEY_FILE: '/run/paykit/master-key',
        PAYKIT_TOKEN_FILE: '/run/paykit/api-token',
        PAYKIT_POSTGRES_PASSWORD_FILE: '/run/paykit/postgres-password',
        PAYKIT_POSTGRES_HOST: 'paykit-postgres',
        PAYKIT_WALLET_CONFIG_FILE: '/run/paykit/wallet-config.json',
      },
      volumes: ['./volumes/paykit:/data', `${secrets}:/run/paykit:ro`],
      depends_on: { 'paykit-postgres': { condition: 'service_healthy' } },
    });
  }

  private mergeCommand(command: string, variables: Record<string, string>) {
    let merged = command;
    Object.keys(variables).forEach(key => {
      // intentionally not using .replace() because if a string is passed in, then only the first occurrence
      // is replaced. A RegExp could be used but the code would be more confusing because of escape chars
      merged = merged.split(`{{${key}}}`).join(variables[key]);
    });
    return merged;
  }
}

export default ComposeFile;
