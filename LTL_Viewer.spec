# -*- mode: python ; coding: utf-8 -*-
#
# PyInstaller spec for LTL Manual Sourcing Viewer.
#
# Playwright + Chromium bundling
# ------------------------------
# Build with the browser installed *inside* the playwright package so it ships
# in the bundle. Before building, run (once):
#
#   set PLAYWRIGHT_BROWSERS_PATH=0
#   python -m playwright install chromium
#   pyinstaller LTL_Viewer.spec
#
# PLAYWRIGHT_BROWSERS_PATH=0 makes `playwright install` place the browser under
# the playwright package dir, which collect_data_files then picks up.

from PyInstaller.utils.hooks import collect_data_files, collect_submodules

block_cipher = None

datas = [
    ('app/templates', 'app/templates'),
    ('app/static', 'app/static'),
    ('logo.ico', '.'),
]
# Playwright driver + bundled browser (when installed with PLAYWRIGHT_BROWSERS_PATH=0).
datas += collect_data_files('playwright', include_py_files=True)

hiddenimports = []
hiddenimports += collect_submodules('playwright')
hiddenimports += collect_submodules('webview')

a = Analysis(
    ['main.py'],
    pathex=[],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=['psycopg2', 'sqlalchemy'],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='LTL_Viewer',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=False,
    icon='logo.ico',
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name='LTL_Viewer',
)
