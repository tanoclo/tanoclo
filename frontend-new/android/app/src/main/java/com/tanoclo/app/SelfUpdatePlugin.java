package com.tanoclo.app;

import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.Iterator;

@CapacitorPlugin(name = "SelfUpdate")
public class SelfUpdatePlugin extends Plugin {

    private String computeFileSha256(File file) {
        if (file == null || !file.exists() || !file.canRead()) {
            return null;
        }
        try (InputStream fis = new FileInputStream(file)) {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] buffer = new byte[8192];
            int n;
            while ((n = fis.read(buffer)) != -1) {
                digest.update(buffer, 0, n);
            }
            byte[] hash = digest.digest();
            StringBuilder hexString = new StringBuilder();
            for (byte b : hash) {
                String hex = Integer.toHexString(0xff & b);
                if (hex.length() == 1) hexString.append('0');
                hexString.append(hex);
            }
            return hexString.toString();
        } catch (Exception e) {
            return null;
        }
    }

    @PluginMethod
    public void getVersionInfo(PluginCall call) {
        try {
            Context context = getContext();
            PackageInfo pInfo = context.getPackageManager().getPackageInfo(context.getPackageName(), 0);
            long versionCode;
            if (Build.VERSION.SDK_INT >= 28) {
                versionCode = pInfo.getLongVersionCode();
            } else {
                versionCode = pInfo.versionCode;
            }
            String versionName = pInfo.versionName;

            String apkPath = context.getPackageCodePath();
            String apkSha256 = computeFileSha256(new File(apkPath));

            JSObject ret = new JSObject();
            ret.put("versionCode", versionCode);
            ret.put("versionName", versionName);
            ret.put("apkSha256", apkSha256 != null ? apkSha256 : "");
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Failed to get version info", e);
        }
    }

    @PluginMethod
    public void canInstallApk(PluginCall call) {
        JSObject ret = new JSObject();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            ret.put("value", getContext().getPackageManager().canRequestPackageInstalls());
        } else {
            ret.put("value", true);
        }
        call.resolve(ret);
    }

    @PluginMethod
    public void openInstallSettings(PluginCall call) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                Uri packageUri = Uri.parse("package:" + getContext().getPackageName());
                Intent intent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, packageUri);
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(intent);
                call.resolve();
            } else {
                call.resolve();
            }
        } catch (Exception e) {
            call.reject("Failed to open install settings", e);
        }
    }

    @PluginMethod
    public void downloadAndInstallApk(PluginCall call) {
        String urlString = call.getString("url");
        if (urlString == null) {
            call.reject("URL is required");
            return;
        }

        JSObject headers = call.getObject("headers");
        String expectedSha256 = call.getString("expectedSha256");

        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    URL url = new URL(urlString);
                    HttpURLConnection connection = (HttpURLConnection) url.openConnection();
                    connection.setRequestMethod("GET");

                    if (headers != null) {
                        Iterator<String> keys = headers.keys();
                        while (keys.hasNext()) {
                            String key = keys.next();
                            try {
                                String value = headers.getString(key);
                                if (value != null) {
                                    connection.setRequestProperty(key, value);
                                }
                            } catch (Exception ignored) {}
                        }
                    }

                    connection.connect();

                    if (connection.getResponseCode() != HttpURLConnection.HTTP_OK) {
                        call.reject("Server returned HTTP " + connection.getResponseCode() + " (" + connection.getResponseMessage() + ")");
                        return;
                    }

                    int fileLength = connection.getContentLength();
                    InputStream input = connection.getInputStream();
                    
                    File cacheDir = getContext().getCacheDir();
                    File apkFile = new File(cacheDir, "update.apk");
                    
                    if (apkFile.exists()) {
                        apkFile.delete();
                    }

                    FileOutputStream output = new FileOutputStream(apkFile);

                    byte[] data = new byte[4096];
                    long total = 0;
                    int count;
                    int lastPercent = -1;
                    while ((count = input.read(data)) != -1) {
                        total += count;
                        if (fileLength > 0) {
                            int progress = (int) (total * 100 / fileLength);
                            if (progress != lastPercent) {
                                lastPercent = progress;
                                JSObject progressData = new JSObject();
                                progressData.put("progress", progress);
                                notifyListeners("downloadProgress", progressData);
                            }
                        }
                        output.write(data, 0, count);
                    }

                    output.flush();
                    output.close();
                    input.close();

                    if (expectedSha256 != null && !expectedSha256.trim().isEmpty()) {
                        String downloadedSha = computeFileSha256(apkFile);
                        if (downloadedSha == null || !downloadedSha.equalsIgnoreCase(expectedSha256.trim())) {
                            call.reject("Downloaded APK checksum verification failed (expected " + expectedSha256 + ", got " + downloadedSha + ")");
                            return;
                        }
                    }

                    triggerInstall(apkFile, call);

                } catch (Exception e) {
                    call.reject("Download failed: " + e.getMessage(), e);
                }
            }
        }).start();
    }

    private void triggerInstall(File apkFile, PluginCall call) {
        getActivity().runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    Context context = getContext();
                    Intent intent = new Intent(Intent.ACTION_VIEW);
                    
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                        Uri apkUri = FileProvider.getUriForFile(
                            context,
                            context.getPackageName() + ".fileprovider",
                            apkFile
                        );
                        intent.setDataAndType(apkUri, "application/vnd.android.package-archive");
                        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    } else {
                        Uri apkUri = Uri.fromFile(apkFile);
                        intent.setDataAndType(apkUri, "application/vnd.android.package-archive");
                        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    }

                    context.startActivity(intent);
                    JSObject ret = new JSObject();
                    ret.put("success", true);
                    call.resolve(ret);
                } catch (Exception e) {
                    call.reject("Installation failed to start: " + e.getMessage(), e);
                }
            }
        });
    }
}
