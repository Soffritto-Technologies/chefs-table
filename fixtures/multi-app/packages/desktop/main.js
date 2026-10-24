const { app, BrowserWindow, Menu, Tray, ipcMain } = require('electron');

let tray = null;

function createWindow() {
  const win = new BrowserWindow({ width: 900, height: 700 });
  win.loadURL('http://localhost:5173');
  return win;
}

app.whenReady().then(() => {
  createWindow();
  tray = new Tray('icon.png');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Acme', click: createWindow },
      { label: 'Connect iMessage' },
      { type: 'separator' },
      { label: 'Quit', role: 'quit' },
    ]),
  );
});

ipcMain.handle('connect-imessage', async () => ({ ok: true }));
ipcMain.on('open-settings', () => createWindow());
