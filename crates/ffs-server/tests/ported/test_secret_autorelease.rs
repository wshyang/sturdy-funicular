//! PORT-4A — test/backend/deno/test-secret-autorelease.test.tsx (49 assertions).
//! Like the legacy no-AWS suite, delivery is seeded with a REAL encrypted payload;
//! submit/retrieve/close and both key-wrap paths run through the Rust HTTP app.
use super::fixtures::*;
use aes_gcm::{aead::{Aead, KeyInit}, Aes256Gcm, Nonce};
use anyhow::{bail, Result};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use ffs_test_support::{parity_assert, parity_assert_eq, TestApp};
use rand::{rngs::OsRng, RngCore};
use rsa::{pkcs8::{DecodePrivateKey, DecodePublicKey, EncodePublicKey}, Oaep, RsaPrivateKey, RsaPublicKey};
use serde_json::{json, Value};
use sha2::Sha256;
use sqlx::Row;

async fn setup(app: &TestApp) -> Result<(FixtureUser, FourStepSystem)> {
    prepare(app).await?;
    let admin = create_admin(app, "SarAdmin!2026").await?;
    let owner = mk_user(app, "agency").await?;
    let s = create_four_step_system(app, admin.id, &owner).await?;
    Ok((admin, s))
}
fn session(s: &FourStepSystem, role: &str) -> String { s.sessions[role].clone() }
async fn post(app: &TestApp, token: &str, path: &str, body: Value) -> Result<(u16, Value)> {
    let (st, data) = app.auth_post_json(path, token, body).await?; Ok((st.as_u16(), data))
}
async fn get(app: &TestApp, token: &str, path: &str) -> Result<(u16, Value)> {
    let (st, data) = app.auth_get_json(path, token).await?; Ok((st.as_u16(), data))
}
async fn ok(result: (u16, Value)) -> Result<Value> {
    if result.0 != 200 { bail!("setup action failed: {} {}", result.0, result.1); }
    Ok(result.1)
}
async fn submit(app: &TestApp, s: &FourStepSystem, overrides: Value) -> Result<(u16, Value)> {
    let now = chrono::Utc::now();
    let mut body = json!({"systemId":s.system_id,
        "justification":"Investigate a production incident requiring elevated access.",
        "srNumber":"SR-9001", "activityStartAt":(now-chrono::Duration::hours(1)).to_rfc3339(),
        "activityEndAt":(now+chrono::Duration::hours(4)).to_rfc3339(),
        "credentialItems":[{"assetId":s.asset_id}]});
    for (k,v) in overrides.as_object().unwrap() { body[k]=v.clone(); }
    post(app, &session(s,"submitter"), "/requests", body).await
}
async fn approve(app: &TestApp, s: &FourStepSystem, id: &str) -> Result<()> {
    for role in ["vendorApprover","agencyApprover","vendorL3Approver","agencyL2Approver"] {
        ok(post(app,&session(s,role),&format!("/requests/{id}/step-decision"),json!({"decision":"approve"})).await?).await?;
    }
    ok(post(app,&session(s,"owner"),&format!("/requests/{id}/owner-decision"),json!({"decision":"approve"})).await?).await?;
    Ok(())
}
async fn key_row(app: &TestApp, id: &str) -> Result<Option<(String,String,String)>> {
    let row = sqlx::query("SELECT public_key, key_algorithm, private_key_wrap_key FROM request_key_material WHERE request_id=$1::uuid")
        .bind(id).fetch_optional(app.db()).await?;
    row.map(|r| Ok((r.try_get("public_key")?,r.try_get("key_algorithm")?,r.try_get("private_key_wrap_key")?))).transpose()
}
async fn seed_delivery(app: &TestApp, id: &str) -> Result<Value> {
    let km = key_row(app,id).await?;
    parity_assert!("L:2a6343aaddc0b2f9-1", km.is_some());
    let public = RsaPublicKey::from_public_key_der(&B64.decode(km.unwrap().0)?)?;
    let mut raw_key = [0u8;32]; OsRng.fill_bytes(&mut raw_key);
    let mut iv = [0u8;12]; OsRng.fill_bytes(&mut iv);
    let encrypted = Aes256Gcm::new_from_slice(&raw_key)?.encrypt(Nonce::from_slice(&iv), b"TEST VALUE".as_slice()).unwrap();
    let split = encrypted.len()-16;
    let encrypted_key = public.encrypt(&mut OsRng, Oaep::new::<Sha256>(), &raw_key)?;
    let payload = json!({"schemaVersion":"1.0","requestId":id,"status":"success",
        "encryptedPayload":{"algorithm":"RSA-OAEP-2048-SHA256+AES-256-GCM",
            "encryptedKey":B64.encode(encrypted_key),"iv":B64.encode(iv),
            "ciphertext":B64.encode(&encrypted[..split]),"authTag":B64.encode(&encrypted[split..])},
        "errorMessage":null,"processedAt":chrono::Utc::now().to_rfc3339()});
    sqlx::query("UPDATE request_key_material SET encrypted_secret_payload=$1 WHERE request_id=$2::uuid")
        .bind(payload.to_string()).bind(id).execute(app.db()).await?;
    Ok(payload)
}
fn decrypt_download(file: &str, wrap_key: &str, payload: &Value) -> Result<String> {
    let envelope: Value = serde_json::from_slice(&B64.decode(file)?)?;
    let wrapped = B64.decode(envelope["wrappedPrivateKey"].as_str().unwrap())?;
    let pkcs8 = Aes256Gcm::new_from_slice(&B64.decode(wrap_key)?)?
        .decrypt(Nonce::from_slice(&B64.decode(envelope["iv"].as_str().unwrap())?), wrapped.as_slice()).map_err(|_| anyhow::anyhow!("private key unwrap failed"))?;
    let private = RsaPrivateKey::from_pkcs8_der(&pkcs8)?;
    let raw = private.decrypt(Oaep::new::<Sha256>(), &B64.decode(payload["encryptedKey"].as_str().unwrap())?)?;
    let mut ciphertext = B64.decode(payload["ciphertext"].as_str().unwrap())?;
    ciphertext.extend(B64.decode(payload["authTag"].as_str().unwrap())?);
    let plaintext = Aes256Gcm::new_from_slice(&raw)?
        .decrypt(Nonce::from_slice(&B64.decode(payload["iv"].as_str().unwrap())?), ciphertext.as_slice()).map_err(|_| anyhow::anyhow!("secret decrypt failed"))?;
    Ok(String::from_utf8(plaintext)?)
}

#[tokio::test]
async fn secret_autorelease_key_material_variants() -> Result<()> {
    TestApp::run("test-secret-autorelease-key-material", |app| async move {
        let (_,s)=setup(&app).await?;
        let (st,data)=submit(&app,&s,json!({})).await?;
        parity_assert_eq!("L:3d18254e1ae3677c-1",st,201);
        parity_assert!("L:63d5895bada27af8-1",data["wrappedPrivateKeyFile"].is_string());
        let file=data["wrappedPrivateKeyFile"].as_str().unwrap();
        let envelope:Value=serde_json::from_slice(&B64.decode(file)?)?;
        parity_assert_eq!("L:798ae9ad8068088b-1",envelope["keyAlgorithm"],"RSA-OAEP-2048-SHA256");
        parity_assert_eq!("L:e75a34f8061c6960-1",envelope["wrapAlgorithm"],"AES-256-GCM");
        parity_assert!("L:874ca26d385000ad-1",envelope["iv"].is_string());
        parity_assert!("L:84596929932a4009-1",envelope["wrappedPrivateKey"].is_string());
        let id=data["request"]["id"].as_str().unwrap();
        let km=key_row(&app,id).await?;
        parity_assert!("L:413827b26a00efa5-1",km.is_some());
        parity_assert_eq!("L:2e579ee97f618188-1",km.unwrap().1,"RSA-OAEP-2048-SHA256");

        let private=RsaPrivateKey::new(&mut OsRng,2048)?;
        let public_b64=B64.encode(private.to_public_key().to_public_key_der()?.as_bytes());
        let (st,data)=submit(&app,&s,json!({"publicKey":public_b64})).await?;
        parity_assert_eq!("L:4818a3192fcbea1a-1",st,201);
        parity_assert_eq!("L:4040dfb535d4312c-1",data.get("wrappedPrivateKeyFile").is_none(),true);
        let id=data["request"]["id"].as_str().unwrap();
        let km=key_row(&app,id).await?;
        parity_assert!("L:9e33c15995c5f515-1",km.is_some());
        let km=km.unwrap();
        parity_assert_eq!("L:e36de994b2c409d9-1",km.0,public_b64);
        parity_assert!("L:44c29190678ae5ae-1",!km.2.is_empty());
        parity_assert_eq!("L:e260f03f2cd8e5fc-1",data["privateKeyWrapKey"],km.2);
        approve(&app,&s,id).await?; seed_delivery(&app,id).await?;
        let (_,material)=get(&app,&session(&s,"submitter"),&format!("/requests/{id}/secret-material")).await?;
        parity_assert_eq!("L:b083ce3a292965af-1",material["privateKeyWrapKey"],km.2);
        let (st,_)=submit(&app,&s,json!({"publicKey":"bm90LWEta2V5"})).await?;
        parity_assert_eq!("L:8ca6f66128a61f4a-1",st,400);
        Ok(())
    }).await
}

#[tokio::test]
async fn secret_autorelease_roundtrip_and_readiness() -> Result<()> {
    TestApp::run("test-secret-autorelease-roundtrip", |app| async move {
        let (_,s)=setup(&app).await?;
        let (_,data)=submit(&app,&s,json!({})).await?;
        let id=data["request"]["id"].as_str().unwrap(); let file=data["wrappedPrivateKeyFile"].as_str().unwrap();
        approve(&app,&s,id).await?; seed_delivery(&app,id).await?;
        let (st,material)=get(&app,&session(&s,"submitter"),&format!("/requests/{id}/secret-material")).await?;
        parity_assert_eq!("L:0c15598ef4ba1fff-1",st,200);
        parity_assert!("L:446a0a9f3ac91442-1",!material["encryptedSecretPayload"].is_null());
        parity_assert_eq!("L:f2f813391d728fa6-1",material["passwordCredentialItems"].as_array().unwrap().len(),1);
        parity_assert_eq!("L:8fcfa42100945249-1",material["passwordCredentialItems"][0]["credentialType"],"password");
        parity_assert_eq!("L:a48bc3e09449010c-1",decrypt_download(file,material["privateKeyWrapKey"].as_str().unwrap(),&material["encryptedSecretPayload"]["encryptedPayload"])?,"TEST VALUE");

        let one=create_asset(&app,s.system_id,"host-one").await?;
        let two=create_asset(&app,s.system_id,"host-two").await?;
        let token=create_asset(&app,s.system_id,"issuer-1").await?;
        sqlx::query("UPDATE assets SET credential_name='svc_one' WHERE id=$1").bind(one).execute(app.db()).await?;
        sqlx::query("UPDATE assets SET credential_name='svc_two' WHERE id=$1").bind(two).execute(app.db()).await?;
        sqlx::query("UPDATE assets SET credential_type='token',credential_name='tok_1' WHERE id=$1").bind(token).execute(app.db()).await?;
        let (_,data)=submit(&app,&s,json!({"credentialItems":[{"assetId":one},{"assetId":two},{"assetId":token}]})).await?;
        let id=data["request"]["id"].as_str().unwrap(); let file=data["wrappedPrivateKeyFile"].as_str().unwrap();
        approve(&app,&s,id).await?; seed_delivery(&app,id).await?;
        let (st,material)=get(&app,&session(&s,"submitter"),&format!("/requests/{id}/secret-material")).await?;
        parity_assert_eq!("L:21a0f388842e4c3f-1",st,200);
        parity_assert_eq!("L:539c0bd564203911-1",material["passwordCredentialItems"].as_array().unwrap().len(),2);
        let mut pairs:Vec<(String,String)>=material["passwordCredentialItems"].as_array().unwrap().iter().map(|i|(i["credentialName"].as_str().unwrap().to_string(),i["hostname"].as_str().unwrap().to_string())).collect(); pairs.sort();
        parity_assert_eq!("L:f3b7a70b1d4c045b-1",pairs,vec![("svc_one".into(),"host-one".into()),("svc_two".into(),"host-two".into())]);
        parity_assert_eq!("L:31a0da6ddbe0c433-1",decrypt_download(file,material["privateKeyWrapKey"].as_str().unwrap(),&material["encryptedSecretPayload"]["encryptedPayload"])?,"TEST VALUE");

        let (_,data)=submit(&app,&s,json!({})).await?; let id=data["request"]["id"].as_str().unwrap();
        let (_,before)=get(&app,&session(&s,"submitter"),&format!("/requests/{id}")).await?;
        parity_assert_eq!("L:511cc40437dbd6a2-1",before["request"]["secretMaterialReady"],false);
        approve(&app,&s,id).await?;
        let (_,gap)=get(&app,&session(&s,"submitter"),&format!("/requests/{id}")).await?;
        parity_assert_eq!("L:03563a119034c6bd-1",gap["request"]["status"],"approved");
        parity_assert_eq!("L:2e075b86c7a49b75-1",gap["request"]["secretMaterialReady"],false);
        seed_delivery(&app,id).await?;
        let (_,ready)=get(&app,&session(&s,"submitter"),&format!("/requests/{id}")).await?;
        parity_assert_eq!("L:728e07ec59d780a0-1",ready["request"]["secretMaterialReady"],true);
        Ok(())
    }).await
}

#[tokio::test]
async fn secret_autorelease_retrieval_guards() -> Result<()> {
    TestApp::run("test-secret-autorelease-guards", |app| async move {
        let (admin,s)=setup(&app).await?; let sub=session(&s,"submitter");
        let (_,data)=submit(&app,&s,json!({})).await?; let id=data["request"]["id"].as_str().unwrap();
        let path=format!("/requests/{id}/secret-material");
        let (st,_)=get(&app,&sub,&path).await?; parity_assert_eq!("L:93ca5b6f96c098da-1",st,403);
        approve(&app,&s,id).await?;
        let (st,body)=get(&app,&sub,&path).await?; parity_assert_eq!("L:f403f588c003e022-1",st,409);
        parity_assert!("L:54cb9acc6b08f0fe-1",body["error"].is_string());
        seed_delivery(&app,id).await?;
        let (st,material)=get(&app,&sub,&path).await?; parity_assert_eq!("L:72a5eb9361f4d727-1",st,200);
        parity_assert!("L:6bb2319922bd7f62-1",material["privateKeyWrapKey"].is_string());
        ok(post(&app,&session(&s,"agencyL2Approver"),&format!("/requests/{id}/issue-credential"),json!({})).await?).await?;
        let (st,_)=get(&app,&sub,&path).await?; parity_assert_eq!("L:d5a70eae15a47707-1",st,200);
        ok(post(&app,&session(&s,"agencyL2Approver"),&format!("/requests/{id}/close"),json!({})).await?).await?;
        let (st,_)=get(&app,&sub,&path).await?; parity_assert_eq!("L:7fb03b03ee108a60-1",st,403);

        let now=chrono::Utc::now();
        let (_,data)=submit(&app,&s,json!({"activityStartAt":(now+chrono::Duration::hours(1)).to_rfc3339(),"activityEndAt":(now+chrono::Duration::hours(2)).to_rfc3339()})).await?;
        let future=data["request"]["id"].as_str().unwrap(); approve(&app,&s,future).await?; seed_delivery(&app,future).await?;
        let (st,_)=get(&app,&sub,&format!("/requests/{future}/secret-material")).await?; parity_assert_eq!("L:ae668e0b79f65e61-1",st,403);

        let (_,data)=submit(&app,&s,json!({})).await?; let id=data["request"]["id"].as_str().unwrap();
        approve(&app,&s,id).await?; seed_delivery(&app,id).await?; let path=format!("/requests/{id}/secret-material");
        let admin_session=session_of(&login_user(&app,&admin).await?)?;
        let (st,_)=get(&app,&session(&s,"outsider"),&path).await?; parity_assert_eq!("L:2747a8f03248844e-1",st,404);
        let (st,_)=get(&app,&admin_session,&path).await?; parity_assert_eq!("L:354dc9a2ce92e269-1",st,404);
        for role in ["vendorApprover","agencyApprover","owner"] {
            let (st,body)=get(&app,&session(&s,role),&path).await?;
            parity_assert_eq!("L:5c9d167146a0a336-1",st,404);
            parity_assert_eq!("L:0733d0aeac381335-1",body.get("privateKeyWrapKey").is_none(),true);
        }
        let (st,material)=get(&app,&sub,&path).await?; parity_assert_eq!("L:f86182c4cd0a1dc5-1",st,200);
        parity_assert!("L:ef5297856235a72a-1",material["privateKeyWrapKey"].is_string());
        let token=create_asset(&app,s.system_id,"token-only").await?;
        sqlx::query("UPDATE assets SET credential_type='token' WHERE id=$1").bind(token).execute(app.db()).await?;
        let (_,data)=submit(&app,&s,json!({"credentialItems":[{"assetId":token}]})).await?;
        let id=data["request"]["id"].as_str().unwrap(); approve(&app,&s,id).await?; seed_delivery(&app,id).await?;
        let (st,material)=get(&app,&sub,&format!("/requests/{id}/secret-material")).await?; parity_assert_eq!("L:0365599577eda831-1",st,200);
        parity_assert_eq!("L:bc19faa6492f0a91-1",material["passwordCredentialItems"].as_array().unwrap().len(),0);
        Ok(())
    }).await
}

#[tokio::test]
async fn secret_autorelease_requester_self_close() -> Result<()> {
    TestApp::run("test-secret-autorelease-self-close", |app| async move {
        let (_,s)=setup(&app).await?; let sub=session(&s,"submitter");
        let (_,data)=submit(&app,&s,json!({})).await?; let id=data["request"]["id"].as_str().unwrap(); approve(&app,&s,id).await?;
        ok(post(&app,&session(&s,"agencyL2Approver"),&format!("/requests/{id}/issue-credential"),json!({})).await?).await?;
        let (st,_)=post(&app,&sub,&format!("/requests/{id}/close"),json!({})).await?; parity_assert_eq!("L:c0293f345ff0e509-1",st,200);
        let (_,detail)=get(&app,&sub,&format!("/requests/{id}")).await?; parity_assert_eq!("L:854d03e201c29ac6-1",detail["request"]["status"],"closed");
        let (_,data)=submit(&app,&s,json!({})).await?; let id=data["request"]["id"].as_str().unwrap(); approve(&app,&s,id).await?;
        let (st,_)=post(&app,&sub,&format!("/requests/{id}/close"),json!({})).await?; parity_assert_eq!("L:495ebb685fc6e284-1",st,400);
        Ok(())
    }).await
}
