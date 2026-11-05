import { afterEach, describe, expect, it } from "vitest";
import { getDeploymentInfo, setDeploymentInfo, statusLabels } from "../src/mode";
import { AnonRpcTransport, NetworkClient } from "../src/net";

afterEach(() => setDeploymentInfo({ verifierKind: "mock", directRecordEnabled: true }));

describe("statusLabels", () => {
  it("labels a mock deployment as a mock proof and never as verified", () => {
    setDeploymentInfo({ verifierKind: "mock", directRecordEnabled: true });
    const labels = statusLabels({ net: new NetworkClient() });
    expect(labels.proof).toBe("Mock proof (not a membership proof)");
    expect(labels.proof.toLowerCase()).not.toContain("verified");
    expect(labels.transport).toBe("Direct transaction: poster address visible");
    expect(labels.anonNetwork).toBe("Not routed (direct)");
  });

  it("follows the deployment", () => {
    setDeploymentInfo({ verifierKind: "semaphore", directRecordEnabled: false });
    expect(getDeploymentInfo()).toEqual({ verifierKind: "semaphore", directRecordEnabled: false });
    const labels = statusLabels({ net: new NetworkClient() });
    expect(labels.proof).toContain("Semaphore");
    expect(labels.transport).toContain("not verified");
  });

  it("follows the network mode and boot state", async () => {
    const anon = new AnonRpcTransport({});
    const client = new NetworkClient();
    client.useTransport(anon);
    expect(statusLabels({ net: client }).anonNetwork).toBe("Anon-RPC: not started");
    await anon.boot().catch(() => undefined);
    expect(statusLabels({ net: client }).anonNetwork).toMatch(/^Anon-RPC: failed: /);
  });
});
