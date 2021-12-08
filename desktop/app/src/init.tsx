/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 */

import {enableMapSet} from 'immer';
import {
  _NuxManagerContext,
  _createNuxManager,
  _setGlobalInteractionReporter,
  _LoggerContext,
} from 'flipper-plugin';
// eslint-disable-next-line no-restricted-imports,flipper/no-electron-remote-imports
import {remote} from 'electron';
import type {RenderHost} from 'flipper-ui-core';
import os from 'os';
import {
  FlipperServerImpl,
  getGatekeepers,
  loadLauncherSettings,
  loadProcessConfig,
  loadSettings,
  setupPrefetcher,
} from 'flipper-server-core';
import {getLogger, isTest, Logger, setLoggerInstance} from 'flipper-common';
import constants from './fb-stubs/constants';
import {initializeElectron} from './electron/initializeElectron';
import path from 'path';
import fs from 'fs';

enableMapSet();

declare global {
  interface Window {
    // We store this as a global, to make sure the renderHost is available
    // before flipper-ui-core is loaded and needs those during module initialisation
    FlipperRenderHostInstance: RenderHost;
  }
}

if (process.env.NODE_ENV === 'development' && os.platform() === 'darwin') {
  // By default Node.JS has its internal certificate storage and doesn't use
  // the system store. Because of this, it's impossible to access ondemand / devserver
  // which are signed using some internal self-issued FB certificates. These certificates
  // are automatically installed to MacOS system store on FB machines, so here we're using
  // this "mac-ca" library to load them into Node.JS.
  global.electronRequire('mac-ca');
}

async function start() {
  const app = remote.app;
  const execPath = process.execPath || remote.process.execPath;
  const appPath = app.getAppPath();
  const isProduction = !/node_modules[\\/]electron[\\/]/.test(execPath);
  const env = process.env;

  const logger = createDelegatedLogger();
  setLoggerInstance(logger);

  let keytar: any = undefined;
  try {
    if (!isTest()) {
      keytar = (global.electronRequire || require)(
        path.join(appPath, 'native-modules', `keytar-${process.platform}.node`),
      );
    }
  } catch (e) {
    console.error('Failed to load keytar:', e);
  }

  const flipperServer = new FlipperServerImpl(
    {
      env,
      gatekeepers: getGatekeepers(),
      isProduction,
      paths: {
        appPath,
        homePath: app.getPath('home'),
        execPath,
        staticPath: getStaticDir(),
        tempPath: app.getPath('temp'),
        desktopPath: app.getPath('desktop'),
      },
      launcherSettings: await loadLauncherSettings(),
      processConfig: loadProcessConfig(env),
      settings: await loadSettings(),
      validWebSocketOrigins: constants.VALID_WEB_SOCKET_REQUEST_ORIGIN_PREFIXES,
    },
    logger,
    keytar,
  );

  await flipperServer.connect();
  const flipperServerConfig = await flipperServer.exec('get-config');

  initializeElectron(flipperServer, flipperServerConfig);

  // By turning this in a require, we force the JS that the body of this module (init) has completed (initializeElectron),
  // before starting the rest of the Flipper process.
  // This prevent issues where the render host is referred at module initialisation level,
  // but not set yet, which might happen when using normal imports.
  // eslint-disable-next-line import/no-commonjs
  require('flipper-ui-core').startFlipperDesktop(flipperServer);

  // Initialize launcher
  setupPrefetcher(flipperServerConfig.settings);
}

start().catch((e) => {
  console.error('Failed to start Flipper desktop', e);
  document.getElementById('root')!.textContent =
    'Failed to start Flipper desktop: ' + e;
});

function getStaticDir() {
  let _staticPath = path.resolve(__dirname, '..', '..', 'static');
  // fs.existSync used here, as fs-extra doesn't resovle properly in the app.asar
  /* eslint-disable node/no-sync*/
  if (fs.existsSync(_staticPath)) {
    // True in unit tests
    return _staticPath;
  }
  if (remote && fs.existsSync(remote.app.getAppPath())) {
    _staticPath = path.join(remote.app.getAppPath());
  }
  if (!fs.existsSync(_staticPath)) {
    throw new Error('Static path does not exist: ' + _staticPath);
  }
  /* eslint-enable node/no-sync*/
  return _staticPath;
}

// getLogger() is not  yet created when the electron app starts.
// we can't create it here yet, as the real logger is wired up to
// the redux store and the rest of the world. So we create a delegating logger
// that uses a simple implementation until the real one comes available
function createDelegatedLogger(): Logger {
  const naiveLogger: Logger = {
    track(...args: [any, any, any?, any?]) {
      console.warn('(skipper track)', args);
    },
    trackTimeSince(...args: [any, any, any?]) {
      console.warn('(skipped trackTimeSince)', args);
    },
    debug(...args: any[]) {
      console.debug(...args);
    },
    error(...args: any[]) {
      console.error(...args);
      console.warn('(skipped error reporting)');
    },
    warn(...args: any[]) {
      console.warn(...args);
      console.warn('(skipped error reporting)');
    },
    info(...args: any[]) {
      console.info(...args);
    },
  };
  // will be overwrittingen later
  setLoggerInstance(naiveLogger);

  return {
    track() {
      // noop
    },
    trackTimeSince() {
      // noop
    },
    debug(...args: any[]) {
      getLogger().debug(...args);
    },
    error(...args: any[]) {
      getLogger().error(...args);
    },
    warn(...args: any[]) {
      getLogger().warn(...args);
    },
    info(...args: any[]) {
      getLogger().info(...args);
    },
  };
}
