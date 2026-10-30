//! PORT-4A — test/backend/deno/direct-links.test.tsx (25 assertions).
use super::fixtures::*;
use anyhow::Result;
use ffs_server::direct_links::{consume_if_valid_for_user, create_link_mapping, generate_mapping_key};
use ffs_test_support::{parity_assert, parity_assert_eq, TestApp};
use serde_json::Value;
use uuid::Uuid;

const GENERIC: &str = "This direct link is no longer valid.";
async fn get(app:&TestApp,token:&str,path:&str)->Result<(u16,Value)> {
    let (st,v)=app.auth_get_json(path,token).await?; Ok((st.as_u16(),v))
}
async fn expired_key(app:&TestApp,admin:Uuid,user:Uuid,target:Uuid)->Result<String> {
    let key=generate_mapping_key();
    sqlx::query("INSERT INTO link_mappings (key,target_type,target_id,created_by,intended_user_id,expires_at,used_count) VALUES ($1,'breakglass_request',$2,$3,$4,now()-interval '1 second',0)")
        .bind(&key).bind(target).bind(admin).bind(user).execute(app.db()).await?;
    Ok(key)
}

#[tokio::test]
async fn direct_links_scoping_and_resolution() -> Result<()> {
    TestApp::run("direct-links", |app| async move {
        prepare(&app).await?;
        let admin=create_admin(&app,"DLAdmin!2026").await?;
        let db=sea_orm::Database::connect(app.db_url()).await?;
        let mut keys=std::collections::HashSet::new();
        for _ in 0..200 {
            let k=generate_mapping_key();
            parity_assert_eq!("L:037d404d6cf5feba-1",k.len(),12);
            parity_assert!("L:b3466561c0f88098-1",k.bytes().all(|b|b.is_ascii_alphanumeric()));
            keys.insert(k);
        }
        parity_assert_eq!("L:1f971a263e093591-1",keys.len(),200);
        let u1=create_active_user(&app,"U1",&unique_email("u1"),"Pass!2026aaa","vendor",true).await?;
        let key=create_link_mapping(&db,"breakglass_request",Uuid::now_v7(),admin.id,Some(u1.id)).await?;
        let first=consume_if_valid_for_user(&db,&key,u1.id).await?;
        parity_assert!("L:c32df07f4bae7a4a-1",first.is_some());
        parity_assert_eq!("L:9786134aed5ac2cf-1",first.as_ref().unwrap().used_count,1);
        parity_assert!("L:e3ca06d758854388-1",first.unwrap().used_at.is_some());
        let second=consume_if_valid_for_user(&db,&key,u1.id).await?;
        parity_assert_eq!("L:3bceff0a9849c775-1",second.unwrap().used_count,2);
        let intended=create_active_user(&app,"Intended",&unique_email("intended"),"Pass!2026aaa","vendor",true).await?;
        let other=create_active_user(&app,"Other",&unique_email("other"),"Pass!2026aaa","vendor",true).await?;
        let key=create_link_mapping(&db,"breakglass_request",Uuid::now_v7(),admin.id,Some(intended.id)).await?;
        parity_assert_eq!("L:b7ac4ae654a2c307-1",consume_if_valid_for_user(&db,&key,other.id).await?.is_none(),true);
        parity_assert!("L:18f0a93af83b8632-1",consume_if_valid_for_user(&db,&key,intended.id).await?.is_some());
        let anyone=create_active_user(&app,"Any",&unique_email("any"),"Pass!2026aaa","vendor",true).await?;
        let key=create_link_mapping(&db,"breakglass_request",Uuid::now_v7(),admin.id,None).await?;
        parity_assert!("L:5261dddf05c291f0-1",consume_if_valid_for_user(&db,&key,anyone.id).await?.is_some());
        let exp=create_active_user(&app,"Exp",&unique_email("exp"),"Pass!2026aaa","vendor",true).await?;
        let key=expired_key(&app,admin.id,exp.id,Uuid::now_v7()).await?;
        parity_assert_eq!("L:b83ac6e68e18978d-1",consume_if_valid_for_user(&db,&key,exp.id).await?.is_none(),true);

        let (st,_)=app.get_json("/link/resolve/anykey123456").await?;
        parity_assert_eq!("L:d7213ac0d7e1bb89-1",st.as_u16(),401);
        let no2fa=create_active_user(&app,"NoTwoFa",&unique_email("no2fa"),"Pass!2026aaa","vendor",false).await?;
        let ns=session_of(&login_user(&app,&no2fa).await?)?;
        let key=create_link_mapping(&db,"breakglass_request",Uuid::now_v7(),admin.id,Some(no2fa.id)).await?;
        let (st,body)=get(&app,&ns,&format!("/link/resolve/{key}")).await?;
        parity_assert_eq!("L:c7bc5b846791ff18-1",st,403);
        parity_assert_eq!("L:f01d79600d462118-1",body["code"],"twofa_required");

        let owner=mk_user(&app,"agency").await?;
        let s=create_four_step_system(&app,admin.id,&owner).await?;
        let sub=session_of(&login_user(&app,&s.submitter).await?)?;
        let (_,data)=submit_four_step(&app,&s,&sub,"Direct link visible request").await?;
        let rid=data["request"]["id"].as_str().unwrap().to_string(); let rid_uuid:Uuid=rid.parse()?;
        let key=create_link_mapping(&db,"breakglass_request",rid_uuid,admin.id,Some(s.submitter.id)).await?;
        let (st,body)=get(&app,&sub,&format!("/link/resolve/{key}")).await?;
        parity_assert_eq!("L:cf79b07708b955cb-1",st,200);
        parity_assert_eq!("L:8e43da295669d823-1",body["targetType"],"breakglass_request");
        parity_assert_eq!("L:4f3ccba7f064156b-1",body["targetId"],rid);
        let key=create_link_mapping(&db,"breakglass_request",rid_uuid,admin.id,Some(s.submitter.id)).await?;
        let outsider=session_of(&login_user(&app,&s.outsider).await?)?;
        let (st,body)=get(&app,&outsider,&format!("/link/resolve/{key}")).await?;
        parity_assert_eq!("L:225e404269fde683-1",st,404);
        parity_assert_eq!("L:9b44867021e072cb-1",body["error"],GENERIC);
        let key=create_link_mapping(&db,"breakglass_request",rid_uuid,admin.id,None).await?;
        let (st,body)=get(&app,&outsider,&format!("/link/resolve/{key}")).await?;
        parity_assert_eq!("L:c062fca54bce93ee-1",st,404);
        parity_assert_eq!("L:60e87840b06add6d-1",body["error"],GENERIC);
        let (st,body)=get(&app,&sub,"/link/resolve/doesnotexist99").await?;
        parity_assert_eq!("L:66d4068d41544ea1-1",st,404);
        parity_assert_eq!("L:5ef6c5225bec32e1-1",body["error"],GENERIC);
        let key=expired_key(&app,admin.id,s.submitter.id,rid_uuid).await?;
        let (st,body)=get(&app,&sub,&format!("/link/resolve/{key}")).await?;
        parity_assert_eq!("L:8bc00ee78fc170dc-1",st,404);
        parity_assert_eq!("L:64a02619f1275d37-1",body["error"],GENERIC);
        Ok(())
    }).await
}
