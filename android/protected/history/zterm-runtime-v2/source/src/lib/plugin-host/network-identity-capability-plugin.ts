import type {
  PluginContext,
  PluginInstance,
} from '@zterm/shared/terminal/plugin-contract';

interface PluginNetworkInterfaceFingerprint {
  name: string;
  addressesSignature: string;
  vpn: boolean;
}

type PluginSampleInterfaces = () => Promise<PluginNetworkInterfaceFingerprint[]>;

export class NetworkIdentityCapabilityPlugin implements PluginInstance {
  async start(context: PluginContext): Promise<void> {
    const sampleInterfaces = context.readCapability<PluginSampleInterfaces>('network:native-snapshot');
    context.provideCapability('network:sample-interfaces', sampleInterfaces);
  }

  async stop(): Promise<void> {}

  async dispose(): Promise<void> {}
}
