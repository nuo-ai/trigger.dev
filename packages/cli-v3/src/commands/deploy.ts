import { intro, log, outro } from "@clack/prompts";
import { getBranch, prepareDeploymentError, tryCatch } from "@trigger.dev/core/v3";
import { InitializeDeploymentResponseBody } from "@trigger.dev/core/v3/schemas";
import { Command, Option as CommandOption } from "commander";
import { resolve } from "node:path";
import { isCI } from "std-env";
import { x } from "tinyexec";
import { z } from "zod";
import { CliApiClient } from "../apiClient.js";
import { buildWorker } from "../build/buildWorker.js";
import { resolveAlwaysExternal } from "../build/externals.js";
import {
  CommonCommandOptions,
  commonOptions,
  handleTelemetry,
  SkipLoggingError,
  wrapCommandAction,
} from "../cli/common.js";
import { loadConfig } from "../config.js";
import { buildImage } from "../deploy/buildImage.js";
import {
  checkLogsForErrors,
  checkLogsForWarnings,
  printErrors,
  printWarnings,
  saveLogs,
} from "../deploy/logs.js";
import { chalkError, cliLink, isLinksSupported, prettyError } from "../utilities/cliOutput.js";
import { loadDotEnvVars } from "../utilities/dotEnv.js";
import { isDirectory } from "../utilities/fileSystem.js";
import { setGithubActionsOutputAndEnvVars } from "../utilities/githubActions.js";
import { createGitMeta } from "../utilities/gitMeta.js";
import { printStandloneInitialBanner } from "../utilities/initialBanner.js";
import { resolveLocalEnvVars } from "../utilities/localEnvVars.js";
import { logger } from "../utilities/logger.js";
import { getProjectClient, upsertBranch } from "../utilities/session.js";
import { getTmpDir } from "../utilities/tempDirectories.js";
import { spinner } from "../utilities/windows.js";
import { login } from "./login.js";
import { archivePreviewBranch } from "./preview.js";
import { updateTriggerPackages } from "./update.js";

const DeployCommandOptions = CommonCommandOptions.extend({
  dryRun: z.boolean().default(false),
  skipSyncEnvVars: z.boolean().default(false),
  env: z.enum(["prod", "staging", "preview"]),
  branch: z.string().optional(),
  loadImage: z.boolean().default(false),
  buildPlatform: z.enum(["linux/amd64", "linux/arm64"]).default("linux/amd64"),
  namespace: z.string().optional(),
  selfHosted: z.boolean().default(false),
  registry: z.string().optional(),
  push: z.boolean().default(false),
  config: z.string().optional(),
  projectRef: z.string().optional(),
  saveLogs: z.boolean().default(false),
  skipUpdateCheck: z.boolean().default(false),
  skipPromotion: z.boolean().default(false),
  noCache: z.boolean().default(false),
  envFile: z.string().optional(),
  network: z.enum(["default", "none", "host"]).optional(),
});

type DeployCommandOptions = z.infer<typeof DeployCommandOptions>;

type Deployment = InitializeDeploymentResponseBody;

export function configureDeployCommand(program: Command) {
  return commonOptions(
    program
      .command("deploy")
      .description("Deploy your Trigger.dev v3 project to the cloud.")
      .argument("[path]", "The path to the project", ".")
      .option(
        "-e, --env <env>",
        "Deploy to a specific environment (currently only prod and staging are supported)",
        "prod"
      )
      .option(
        "-b, --branch <branch>",
        "The preview branch to deploy to when passing --env preview. If not provided, we'll detect your git branch."
      )
      .option("--skip-update-check", "Skip checking for @trigger.dev package updates")
      .option("-c, --config <config file>", "The name of the config file, found at [path]")
      .option(
        "-p, --project-ref <project ref>",
        "The project ref. Required if there is no config file. This will override the project specified in the config file."
      )
      .option(
        "--dry-run",
        "Do a dry run of the deployment. This will not actually deploy the project, but will show you what would be deployed."
      )
      .option(
        "--skip-sync-env-vars",
        "Skip syncing environment variables when using the syncEnvVars extension."
      )
      .option(
        "--env-file <env file>",
        "Path to the .env file to load into the CLI process. Defaults to .env in the project directory."
      )
      .option(
        "--skip-promotion",
        "Skip promoting the deployment to the current deployment for the environment."
      )
  )
    .addOption(
      new CommandOption(
        "--self-hosted",
        "Build and load the image using your local Docker. Use the --registry option to specify the registry to push the image to when using --self-hosted, or just use --push to push to the default registry."
      ).hideHelp()
    )
    .addOption(
      new CommandOption(
        "--no-cache",
        "Do not use the cache when building the image. This will slow down the build process but can be useful if you are experiencing issues with the cache."
      ).hideHelp()
    )
    .addOption(
      new CommandOption(
        "--push",
        "When using the --self-hosted flag, push the image to the default registry. (defaults to false when not using --registry)"
      ).hideHelp()
    )
    .addOption(
      new CommandOption(
        "--registry <registry>",
        "The registry to push the image to when using --self-hosted"
      ).hideHelp()
    )
    .addOption(
      new CommandOption(
        "--tag <tag>",
        "(Coming soon) Specify the tag to use when pushing the image to the registry"
      ).hideHelp()
    )
    .addOption(
      new CommandOption(
        "--namespace <namespace>",
        "Specify the namespace to use when pushing the image to the registry"
      ).hideHelp()
    )
    .addOption(
      new CommandOption("--load-image", "Load the built image into your local docker").hideHelp()
    )
    .addOption(
      new CommandOption(
        "--build-platform <platform>",
        "The platform to build the deployment image for"
      )
        .default("linux/amd64")
        .hideHelp()
    )
    .addOption(
      new CommandOption(
        "--save-logs",
        "If provided, will save logs even for successful builds"
      ).hideHelp()
    )
    .option("--network <mode>", "The networking mode for RUN instructions when using --self-hosted")
    .action(async (path, options) => {
      await handleTelemetry(async () => {
        await printStandloneInitialBanner(true);
        await deployCommand(path, options);
      });
    });
}

export async function deployCommand(dir: string, options: unknown) {
  return await wrapCommandAction("deployCommand", DeployCommandOptions, options, async (opts) => {
    return await _deployCommand(dir, opts);
  });
}

async function _deployCommand(dir: string, options: DeployCommandOptions) {
  intro(`Deploying project${options.skipPromotion ? " (without promotion)" : ""}`);

  if (!options.skipUpdateCheck) {
    await updateTriggerPackages(dir, { ...options }, true, true);
  }

  const cwd = process.cwd();
  const projectPath = resolve(cwd, dir);

  verifyDirectory(dir, projectPath);

  const authorization = await login({
    embedded: true,
    defaultApiUrl: options.apiUrl,
    profile: options.profile,
  });

  if (!authorization.ok) {
    if (authorization.error === "fetch failed") {
      throw new Error(
        `Failed to connect to ${authorization.auth?.apiUrl}. Are you sure it's the correct URL?`
      );
    } else {
      throw new Error(
        `You must login first. Use the \`login\` CLI command.\n\n${authorization.error}`
      );
    }
  }

  const envVars = resolveLocalEnvVars(options.envFile);

  if (envVars.TRIGGER_PROJECT_REF) {
    logger.debug("Using project ref from env", { ref: envVars.TRIGGER_PROJECT_REF });
  }

  const resolvedConfig = await loadConfig({
    cwd: projectPath,
    overrides: { project: options.projectRef ?? envVars.TRIGGER_PROJECT_REF },
    configFile: options.config,
  });

  logger.debug("Resolved config", resolvedConfig);

  const gitMeta = await createGitMeta(resolvedConfig.workspaceDir);
  logger.debug("gitMeta", gitMeta);

  const branch =
    options.env === "preview" ? getBranch({ specified: options.branch, gitMeta }) : undefined;
  if (options.env === "preview" && !branch) {
    throw new Error(
      "Didn't auto-detect preview branch, so you need to specify one. Pass --branch <branch>."
    );
  }

  if (options.env === "preview" && branch) {
    //auto-archive a branch if the PR is merged or closed
    if (gitMeta?.pullRequestState === "merged" || gitMeta?.pullRequestState === "closed") {
      log.message(`Pull request ${gitMeta?.pullRequestNumber} is ${gitMeta?.pullRequestState}.`);
      const $buildSpinner = spinner();
      $buildSpinner.start(`Archiving preview branch: "${branch}"`);
      const result = await archivePreviewBranch(authorization, branch, resolvedConfig.project);
      $buildSpinner.stop(
        result ? `Successfully archived "${branch}"` : `Failed to archive "${branch}".`
      );
      return;
    }

    logger.debug("Upserting branch", { env: options.env, branch });
    const branchEnv = await upsertBranch({
      accessToken: authorization.auth.accessToken,
      apiUrl: authorization.auth.apiUrl,
      projectRef: resolvedConfig.project,
      branch,
      gitMeta,
    });

    logger.debug("Upserted branch env", branchEnv);

    log.success(`Using preview branch "${branch}"`);

    if (!branchEnv) {
      throw new Error(`Failed to create branch "${branch}"`);
    }
  }

  const projectClient = await getProjectClient({
    accessToken: authorization.auth.accessToken,
    apiUrl: authorization.auth.apiUrl,
    projectRef: resolvedConfig.project,
    env: options.env,
    branch,
    profile: options.profile,
  });

  if (!projectClient) {
    throw new Error("Failed to get project client");
  }

  const serverEnvVars = await projectClient.client.getEnvironmentVariables(resolvedConfig.project);
  loadDotEnvVars(resolvedConfig.workingDir, options.envFile);

  const destination = getTmpDir(resolvedConfig.workingDir, "build", options.dryRun);

  const $buildSpinner = spinner();

  const forcedExternals = await resolveAlwaysExternal(projectClient.client);

  const { features } = resolvedConfig;

  const [error, buildManifest] = await tryCatch(
    buildWorker({
      target: "deploy",
      environment: options.env,
      branch,
      destination: destination.path,
      resolvedConfig,
      rewritePaths: true,
      envVars: serverEnvVars.success ? serverEnvVars.data.variables : {},
      forcedExternals,
      listener: {
        onBundleStart() {
          $buildSpinner.start("Building trigger code");
        },
        onBundleComplete(result) {
          $buildSpinner.stop("Successfully built code");

          logger.debug("Bundle result", result);
        },
      },
    })
  );

  if (error) {
    $buildSpinner.stop("Failed to build code");
    throw error;
  }

  logger.debug("Successfully built project to", destination.path);

  if (options.dryRun) {
    logger.info(`Dry run complete. View the built project at ${destination.path}`);
    return;
  }

  const deploymentResponse = await projectClient.client.initializeDeployment({
    contentHash: buildManifest.contentHash,
    userId: authorization.userId,
    selfHosted: options.selfHosted,
    registryHost: options.registry,
    namespace: options.namespace,
    gitMeta,
    type: features.run_engine_v2 ? "MANAGED" : "V1",
  });

  if (!deploymentResponse.success) {
    throw new Error(`Failed to start deployment: ${deploymentResponse.error}`);
  }

  const deployment = deploymentResponse.data;

  // If the deployment doesn't have any externalBuildData, then we can't use the remote image builder
  // TODO: handle this and allow the user to the build and push the image themselves
  if (!deployment.externalBuildData && !options.selfHosted) {
    throw new Error(
      `Failed to start deployment, as your instance of trigger.dev does not support hosting. To deploy this project, you must use the --self-hosted flag to build and push the image yourself.`
    );
  }

  if (options.selfHosted) {
    const result = await x("docker", ["buildx", "version"]);

    if (result.exitCode !== 0) {
      logger.debug(`"docker buildx version" failed (${result.exitCode}):`, result);
      throw new Error(
        "Failed to find docker buildx. Please install it: https://github.com/docker/buildx#installing."
      );
    }
  }

  const hasVarsToSync =
    buildManifest.deploy.sync &&
    ((buildManifest.deploy.sync.env && Object.keys(buildManifest.deploy.sync.env).length > 0) ||
      (buildManifest.deploy.sync.parentEnv &&
        Object.keys(buildManifest.deploy.sync.parentEnv).length > 0));

  if (hasVarsToSync) {
    const childVars = buildManifest.deploy.sync?.env ?? {};
    const parentVars = buildManifest.deploy.sync?.parentEnv ?? {};

    const numberOfEnvVars = Object.keys(childVars).length + Object.keys(parentVars).length;
    const vars = numberOfEnvVars === 1 ? "var" : "vars";

    if (!options.skipSyncEnvVars) {
      const $spinner = spinner();
      $spinner.start(`Syncing ${numberOfEnvVars} env ${vars} with the server`);
      const success = await syncEnvVarsWithServer(
        projectClient.client,
        resolvedConfig.project,
        options.env,
        childVars,
        parentVars
      );

      if (!success) {
        await failDeploy(
          projectClient.client,
          deployment,
          {
            name: "SyncEnvVarsError",
            message: `Failed to sync ${numberOfEnvVars} env ${vars} with the server`,
          },
          "",
          $spinner
        );
      } else {
        $spinner.stop(`Successfully synced ${numberOfEnvVars} env ${vars} with the server`);
      }
    } else {
      logger.log(
        "Skipping syncing env vars. The environment variables in your project have changed, but the --skip-sync-env-vars flag was provided."
      );
    }
  }

  const version = deployment.version;

  const rawDeploymentLink = `${authorization.dashboardUrl}/projects/v3/${resolvedConfig.project}/deployments/${deployment.shortCode}`;
  const rawTestLink = `${authorization.dashboardUrl}/projects/v3/${
    resolvedConfig.project
  }/test?environment=${options.env === "prod" ? "prod" : "stg"}`;

  const deploymentLink = cliLink("View deployment", rawDeploymentLink);
  const testLink = cliLink("Test tasks", rawTestLink);

  const $spinner = spinner();

  if (isCI) {
    log.step(`Building version ${version}\n`);
  } else {
    if (isLinksSupported) {
      $spinner.start(`Building version ${version} ${deploymentLink}`);
    } else {
      $spinner.start(`Building version ${version}`);
    }
  }

  const selfHostedRegistryHost = deployment.registryHost ?? options.registry;
  const registryHost = selfHostedRegistryHost ?? "registry.trigger.dev";

  const buildResult = await buildImage({
    selfHosted: options.selfHosted,
    buildPlatform: options.buildPlatform,
    noCache: options.noCache,
    push: options.push,
    registryHost,
    registry: options.registry,
    deploymentId: deployment.id,
    deploymentVersion: deployment.version,
    imageTag: deployment.imageTag,
    loadImage: options.loadImage,
    contentHash: deployment.contentHash,
    externalBuildId: deployment.externalBuildData?.buildId,
    externalBuildToken: deployment.externalBuildData?.buildToken,
    externalBuildProjectId: deployment.externalBuildData?.projectId,
    projectId: projectClient.id,
    projectRef: resolvedConfig.project,
    apiUrl: projectClient.client.apiURL,
    apiKey: projectClient.client.accessToken!,
    branchName: branch,
    authAccessToken: authorization.auth.accessToken,
    compilationPath: destination.path,
    buildEnvVars: buildManifest.build.env,
    network: options.network,
    onLog: (logMessage) => {
      if (isCI) {
        console.log(logMessage);
        return;
      }

      if (isLinksSupported) {
        $spinner.message(`Building version ${version} ${deploymentLink}: ${logMessage}`);
      } else {
        $spinner.message(`Building version ${version}: ${logMessage}`);
      }
    },
  });

  logger.debug("Build result", buildResult);

  const warnings = checkLogsForWarnings(buildResult.logs);

  if (!warnings.ok) {
    await failDeploy(
      projectClient.client,
      deployment,
      { name: "BuildError", message: warnings.summary },
      buildResult.logs,
      $spinner,
      warnings.warnings,
      warnings.errors
    );

    throw new SkipLoggingError("Failed to build image");
  }

  if (!buildResult.ok) {
    await failDeploy(
      projectClient.client,
      deployment,
      { name: "BuildError", message: buildResult.error },
      buildResult.logs,
      $spinner,
      warnings.warnings
    );

    throw new SkipLoggingError("Failed to build image");
  }

  const getDeploymentResponse = await projectClient.client.getDeployment(deployment.id);

  if (!getDeploymentResponse.success) {
    await failDeploy(
      projectClient.client,
      deployment,
      { name: "DeploymentError", message: getDeploymentResponse.error },
      buildResult.logs,
      $spinner
    );

    throw new SkipLoggingError(getDeploymentResponse.error);
  }

  const deploymentWithWorker = getDeploymentResponse.data;

  if (!deploymentWithWorker.worker) {
    const errorData = deploymentWithWorker.errorData
      ? prepareDeploymentError(deploymentWithWorker.errorData)
      : undefined;

    await failDeploy(
      projectClient.client,
      deployment,
      {
        name: "DeploymentError",
        message: errorData?.message ?? "Failed to get deployment with worker",
      },
      buildResult.logs,
      $spinner
    );

    throw new SkipLoggingError(errorData?.message ?? "Failed to get deployment with worker");
  }

  const imageReference = options.selfHosted
    ? `${selfHostedRegistryHost ? `${selfHostedRegistryHost}/` : ""}${buildResult.image}${
        buildResult.digest ? `@${buildResult.digest}` : ""
      }`
    : `${buildResult.image}${buildResult.digest ? `@${buildResult.digest}` : ""}`;

  if (isCI) {
    log.step(`Deploying version ${version}\n`);
  } else {
    if (isLinksSupported) {
      $spinner.message(`Deploying version ${version} ${deploymentLink}`);
    } else {
      $spinner.message(`Deploying version ${version}`);
    }
  }

  const finalizeResponse = await projectClient.client.finalizeDeployment(
    deployment.id,
    {
      imageReference,
      selfHosted: options.selfHosted,
      skipPromotion: options.skipPromotion,
    },
    (logMessage) => {
      if (isCI) {
        console.log(logMessage);
        return;
      }

      if (isLinksSupported) {
        $spinner.message(`Deploying version ${version} ${deploymentLink}: ${logMessage}`);
      } else {
        $spinner.message(`Deploying version ${version}: ${logMessage}`);
      }
    }
  );

  if (!finalizeResponse.success) {
    await failDeploy(
      projectClient.client,
      deployment,
      { name: "FinalizeError", message: finalizeResponse.error },
      buildResult.logs,
      $spinner
    );

    throw new SkipLoggingError("Failed to finalize deployment");
  }

  if (isCI) {
    log.step(`Successfully deployed version ${version}`);
  } else {
    $spinner.stop(`Successfully deployed version ${version}`);
  }

  const taskCount = deploymentWithWorker.worker?.tasks.length ?? 0;

  outro(
    `Version ${version} deployed with ${taskCount} detected task${taskCount === 1 ? "" : "s"} ${
      isLinksSupported ? `| ${deploymentLink} | ${testLink}` : ""
    }`
  );

  if (!isLinksSupported) {
    console.log("View deployment");
    console.log(rawDeploymentLink);
    console.log(); // new line
    console.log("Test tasks");
    console.log(rawTestLink);
  }

  setGithubActionsOutputAndEnvVars({
    envVars: {
      TRIGGER_DEPLOYMENT_VERSION: version,
      TRIGGER_VERSION: version,
      TRIGGER_DEPLOYMENT_SHORT_CODE: deployment.shortCode,
      TRIGGER_DEPLOYMENT_URL: `${authorization.dashboardUrl}/projects/v3/${resolvedConfig.project}/deployments/${deployment.shortCode}`,
      TRIGGER_TEST_URL: `${authorization.dashboardUrl}/projects/v3/${
        resolvedConfig.project
      }/test?environment=${options.env === "prod" ? "prod" : "stg"}`,
    },
    outputs: {
      deploymentVersion: version,
      workerVersion: version,
      deploymentShortCode: deployment.shortCode,
      deploymentUrl: `${authorization.dashboardUrl}/projects/v3/${resolvedConfig.project}/deployments/${deployment.shortCode}`,
      testUrl: `${authorization.dashboardUrl}/projects/v3/${
        resolvedConfig.project
      }/test?environment=${options.env === "prod" ? "prod" : "stg"}`,
      needsPromotion: options.skipPromotion ? "true" : "false",
    },
  });
}

export async function syncEnvVarsWithServer(
  apiClient: CliApiClient,
  projectRef: string,
  environmentSlug: string,
  envVars: Record<string, string>,
  parentEnvVars?: Record<string, string>
) {
  const uploadResult = await apiClient.importEnvVars(projectRef, environmentSlug, {
    variables: envVars,
    parentVariables: parentEnvVars,
    override: true,
  });

  return uploadResult.success;
}

async function failDeploy(
  client: CliApiClient,
  deployment: Deployment,
  error: { name: string; message: string },
  logs: string,
  $spinner: ReturnType<typeof spinner>,
  warnings?: string[],
  errors?: string[]
) {
  logger.debug("failDeploy", { error, logs, warnings, errors });

  $spinner.stop(`Failed to deploy project`);

  const doOutputLogs = async (prefix: string = "Error") => {
    if (logs.trim() !== "") {
      const logPath = await saveLogs(deployment.shortCode, logs);

      printWarnings(warnings);
      printErrors(errors);

      checkLogsForErrors(logs);

      outro(
        `${chalkError(`${prefix}:`)} ${
          error.message
        }. Full build logs have been saved to ${logPath}`
      );
    } else {
      outro(`${chalkError(`${prefix}:`)} ${error.message}.`);
    }
  };

  const exitCommand = (message: string) => {
    throw new SkipLoggingError(message);
  };

  const deploymentResponse = await client.getDeployment(deployment.id);

  if (!deploymentResponse.success) {
    logger.debug(`Failed to get deployment with worker: ${deploymentResponse.error}`);
  } else {
    const serverDeployment = deploymentResponse.data;

    switch (serverDeployment.status) {
      case "PENDING":
      case "DEPLOYING":
      case "BUILDING": {
        await doOutputLogs();

        await client.failDeployment(deployment.id, {
          error,
        });

        exitCommand("Failed to deploy project");

        break;
      }
      case "CANCELED": {
        await doOutputLogs("Canceled");

        exitCommand("Failed to deploy project");

        break;
      }
      case "FAILED": {
        const errorData = serverDeployment.errorData
          ? prepareDeploymentError(serverDeployment.errorData)
          : undefined;

        if (errorData) {
          prettyError(errorData.message, errorData.stack, errorData.stderr);

          if (logs.trim() !== "") {
            const logPath = await saveLogs(deployment.shortCode, logs);

            outro(`Aborting deployment. Full build logs have been saved to ${logPath}`);
          } else {
            outro(`Aborting deployment`);
          }
        } else {
          await doOutputLogs("Failed");
        }

        exitCommand("Failed to deploy project");

        break;
      }
      case "DEPLOYED": {
        await doOutputLogs("Deployed with errors");

        exitCommand("Deployed with errors");

        break;
      }
      case "TIMED_OUT": {
        await doOutputLogs("TimedOut");

        exitCommand("Timed out");

        break;
      }
    }
  }
}

export function verifyDirectory(dir: string, projectPath: string) {
  if (dir !== "." && !isDirectory(projectPath)) {
    if (dir === "staging" || dir === "prod" || dir === "preview") {
      throw new Error(`To deploy to ${dir}, you need to pass "--env ${dir}", not just "${dir}".`);
    }

    if (dir === "production") {
      throw new Error(`To deploy to production, you need to pass "--env prod", not "production".`);
    }

    if (dir === "stg") {
      throw new Error(`To deploy to staging, you need to pass "--env staging", not "stg".`);
    }

    throw new Error(`Directory "${dir}" not found at ${projectPath}`);
  }
}
