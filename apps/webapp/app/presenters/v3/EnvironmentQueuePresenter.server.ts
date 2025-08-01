import { type AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { marqs } from "~/v3/marqs/index.server";
import { engine } from "~/v3/runEngine.server";
import { BasePresenter } from "./basePresenter.server";

export type Environment = {
  running: number;
  queued: number;
  concurrencyLimit: number;
  burstFactor: number;
  runsEnabled: boolean;
};

export class EnvironmentQueuePresenter extends BasePresenter {
  async call(environment: AuthenticatedEnvironment): Promise<Environment> {
    const [engineV1Executing, engineV2Executing, engineV1Queued, engineV2Queued] =
      await Promise.all([
        marqs.currentConcurrencyOfEnvironment(environment),
        engine.concurrencyOfEnvQueue(environment),
        marqs.lengthOfEnvQueue(environment),
        engine.lengthOfEnvQueue(environment),
      ]);

    const running = (engineV1Executing ?? 0) + (engineV2Executing ?? 0);
    const queued = (engineV1Queued ?? 0) + (engineV2Queued ?? 0);

    const organization = await this._replica.organization.findFirst({
      where: {
        id: environment.organizationId,
      },
      select: {
        runsEnabled: true,
      },
    });

    if (!organization) {
      throw new Error("Organization not found");
    }

    return {
      running,
      queued,
      concurrencyLimit: environment.maximumConcurrencyLimit,
      burstFactor: environment.concurrencyLimitBurstFactor.toNumber(),
      runsEnabled: environment.type === "DEVELOPMENT" || organization.runsEnabled,
    };
  }
}
