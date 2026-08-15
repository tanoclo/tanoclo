package com.tanoclo.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import java.io.File;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Clear WebView cache before load if app version code updated
        checkAndClearWebViewCache();

        registerPlugin(SelfUpdatePlugin.class);
        super.onCreate(savedInstanceState);
        
        // Clear WebView cache on start to prevent loading outdated code-split chunks
        if (this.bridge != null && this.bridge.getWebView() != null) {
            this.bridge.getWebView().clearCache(true);
        }
    }

    private void checkAndClearWebViewCache() {
        try {
            SharedPreferences prefs = getSharedPreferences("tanoclo_prefs", Context.MODE_PRIVATE);
            PackageInfo pInfo = getPackageManager().getPackageInfo(getPackageName(), 0);
            
            long currentVersionCode;
            if (android.os.Build.VERSION.SDK_INT >= 28) {
                currentVersionCode = pInfo.getLongVersionCode();
            } else {
                currentVersionCode = pInfo.versionCode;
            }
            
            long lastVersionCode = prefs.getLong("last_version_code", -1);

            if (currentVersionCode != lastVersionCode) {
                // App version updated, clear the cache directories
                File cacheDir = getCacheDir();
                if (cacheDir != null) {
                    deleteDir(cacheDir);
                }
                prefs.edit().putLong("last_version_code", currentVersionCode).apply();
            }
        } catch (Exception e) {
            e.printStackTrace();
        }
    }

    private boolean deleteDir(File dir) {
        if (dir != null && dir.isDirectory()) {
            String[] children = dir.list();
            if (children != null) {
                for (String child : children) {
                    boolean success = deleteDir(new File(dir, child));
                    if (!success) {
                        return false;
                    }
                }
            }
            return dir.delete();
        } else if (dir != null && dir.isFile()) {
            return dir.delete();
        } else {
            return false;
        }
    }
}

