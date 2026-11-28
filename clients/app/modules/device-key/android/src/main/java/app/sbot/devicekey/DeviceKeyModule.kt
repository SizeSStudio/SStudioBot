// Device identity key on Android (docs/tech/06 「设备密钥」, P4).
//   API ≥ 33 and Keystore takes Ed25519: generate it in the Keystore (StrongBox when there is one), never exportable;
//   otherwise JS generates it with noble and this module wraps the 32-byte seed with a non-exportable Keystore
//   AES-GCM key; only the ciphertext is written, in the app's private files dir.
// Uninstalling or clearing data loses the key on purpose: pair again (06: no export, no backup).
// 待测（手机）：real-device Keystore Ed25519, StrongBox, survival across kill / reboot / app update, ≤ 50 ms per sign.
package app.sbot.devicekey

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

private const val KS = "AndroidKeyStore"
private const val ED_ALIAS = "sbot-device-ed25519"
private const val WRAP_ALIAS = "sbot-device-wrap"
private const val WRAPPED_FILE = "device-key.wrapped"
private const val PREFS = "sbot-device"
private const val B64 = Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP

class DeviceKeyModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw IllegalStateException("no react context")

  private fun keyStore(): KeyStore = KeyStore.getInstance(KS).apply { load(null) }

  private fun hasStrongBox(): Boolean =
    Build.VERSION.SDK_INT >= 28 && context.packageManager.hasSystemFeature(PackageManager.FEATURE_STRONGBOX_KEYSTORE)

  // Ed25519 SPKI is a fixed 12-byte header + the 32-byte key
  private fun rawPublic(encoded: ByteArray): ByteArray = encoded.copyOfRange(encoded.size - 32, encoded.size)

  private fun hardwarePublic(create: Boolean): ByteArray? {
    if (Build.VERSION.SDK_INT < 33) return null
    val ks = keyStore()
    ks.getCertificate(ED_ALIAS)?.let { return rawPublic(it.publicKey.encoded) }
    if (!create) return null
    // try StrongBox first, then the TEE; any failure means this device's KeyMint has no Ed25519
    for (strong in listOf(true, false)) {
      if (strong && !hasStrongBox()) continue
      try {
        val spec = KeyGenParameterSpec.Builder(ED_ALIAS, KeyProperties.PURPOSE_SIGN)
          .setAlgorithmParameterSpec(ECGenParameterSpec("ed25519"))
          .setDigests(KeyProperties.DIGEST_NONE)
          .apply { if (strong) setIsStrongBoxBacked(true) }
          .build()
        val kpg = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, KS)
        kpg.initialize(spec)
        val pair = kpg.generateKeyPair()
        val pub = rawPublic(pair.public.encoded)
        if (pub.size == 32 && selfTest(pair.private)) return pub
        ks.deleteEntry(ED_ALIAS)
      } catch (e: Exception) {
        try { ks.deleteEntry(ED_ALIAS) } catch (_: Exception) {}
      }
    }
    return null
  }

  private fun selfTest(key: PrivateKey): Boolean = try {
    Signature.getInstance("Ed25519").run { initSign(key); update(byteArrayOf(1, 2, 3)); sign().size == 64 }
  } catch (e: Exception) { false }

  private fun wrapKey(): SecretKey {
    val ks = keyStore()
    (ks.getKey(WRAP_ALIAS, null) as? SecretKey)?.let { return it }
    val kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KS)
    val build = { strong: Boolean ->
      KeyGenParameterSpec.Builder(WRAP_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        .apply { if (strong && Build.VERSION.SDK_INT >= 28) setIsStrongBoxBacked(true) }
        .build()
    }
    return try {
      kg.init(build(hasStrongBox())); kg.generateKey()
    } catch (e: Exception) {
      kg.init(build(false)); kg.generateKey()
    }
  }

  private fun wrappedFile() = File(context.filesDir, WRAPPED_FILE)

  override fun definition() = ModuleDefinition {
    Name("DeviceKey")

    AsyncFunction("hardwarePublicKey") { create: Boolean ->
      hardwarePublic(create)?.let { Base64.encodeToString(it, B64) }
    }

    // a new pairing gets a new key (06: a key the hub has seen can never pair again); unpairing drops it
    AsyncFunction("deleteKeys") { ->
      val ks = keyStore()
      if (ks.containsAlias(ED_ALIAS)) ks.deleteEntry(ED_ALIAS)
      wrappedFile().delete()
      Unit
    }

    AsyncFunction("hardwareSign") { message: String ->
      val key = keyStore().getKey(ED_ALIAS, null) as? PrivateKey ?: throw IllegalStateException("no hardware key")
      val sig = Signature.getInstance("Ed25519").run { initSign(key); update(Base64.decode(message, B64)); sign() }
      Base64.encodeToString(sig, B64)
    }

    AsyncFunction("loadWrapped") { ->
      val f = wrappedFile()
      if (!f.exists()) return@AsyncFunction null
      val blob = f.readBytes()
      val c = Cipher.getInstance("AES/GCM/NoPadding")
      c.init(Cipher.DECRYPT_MODE, wrapKey(), GCMParameterSpec(128, blob.copyOfRange(0, 12)))
      Base64.encodeToString(c.doFinal(blob.copyOfRange(12, blob.size)), B64)
    }

    AsyncFunction("storeWrapped") { seed: String ->
      val plain = Base64.decode(seed, B64)
      require(plain.size == 32) { "seed must be 32 bytes" }
      val c = Cipher.getInstance("AES/GCM/NoPadding")
      c.init(Cipher.ENCRYPT_MODE, wrapKey()) // the Keystore picks the IV; we store it in front
      val blob = c.iv + c.doFinal(plain)
      plain.fill(0)
      val tmp = File(context.filesDir, "$WRAPPED_FILE.tmp")
      tmp.writeBytes(blob)
      if (!tmp.renameTo(wrappedFile())) throw IllegalStateException("could not store the key")
    }

    AsyncFunction("getPairing") { ->
      context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("pairing", null)
    }

    AsyncFunction("setPairing") { json: String? ->
      context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().apply {
        if (json == null) remove("pairing") else putString("pairing", json)
      }.commit()
      Unit
    }

    AsyncFunction("info") { ->
      mapOf("sdk" to Build.VERSION.SDK_INT, "strongbox" to hasStrongBox())
    }
  }
}
